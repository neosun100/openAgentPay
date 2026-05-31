/**
 * Ripple / XRP Ledger Wallet Connector
 * ====================================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for the XRP
 * Ledger — Ed25519 keys encoded as classic "r..." addresses (XRPL base58check
 * with Ripple's CUSTOM alphabet), 6-decimal native asset (XRP, drops), and a
 * single-op Payment settlement model.
 *
 *   - Account model: EVM nonces → XRPL sequence numbers (stateless here)
 *   - Crypto: secp256k1 ECDSA (EVM) → Ed25519 (XRPL, prefixed 0xED)
 *   - Recipient: 0x… (EVM) → classic "r…" (XRPL)
 *   - Settlement: smart-contract call (EVM) → Payment transaction (rippled submit)
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Implementation strategy: PURE TypeScript (no xrpl.js / ripple-keypairs). Real
 * signing via RealRippleSigner (@noble/curves Ed25519). On-chain broadcast is
 * behind a pluggable `submit` hook on the signer, defaulting to offline-safe.
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type Money,
  type ProtocolId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type TransactionRef,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "xrpl-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "ripple" as WalletProviderId;
export const X_PAYMENT_RIPPLE_HEADER = "X-PAYMENT-RIPPLE";

/** XRP uses 6 decimal places — 1 XRP = 1,000,000 drops. */
const XRP_DECIMALS = 6;

// ============================================================================
//  Ripple signer abstraction (pluggable)
// ============================================================================

export interface RippleSigner {
  /** Classic XRPL address ("r..."). */
  readonly address: string;
  /** XRPL ed25519 public key, prefixed (0xED || raw32), hex — 33 bytes. */
  readonly publicKeyHex: string;
  /**
   * Sign + (optionally) submit an XRPL Payment. Implementations:
   *   - DemoRippleSigner (this file) — fake signature for tests
   *   - RealRippleSigner (real-signer.ts) — real Ed25519, pluggable broadcast
   *   - xrpl.js based signer (production)
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly currency?: string;
    readonly destinationTag?: string;
  }): Promise<{
    readonly signatureHex: string;
    readonly publicKeyHex: string;
    readonly hash?: string;
    readonly ledgerIndex?: number;
    readonly explorerUrl?: string;
  }>;
  getBalance(currency?: string): Promise<bigint>;
}

/**
 * In-memory signer for unit tests. Produces a deterministic-ish fake signature —
 * never used in production. The conformance suite uses RealRippleSigner.
 */
export class DemoRippleSigner implements RippleSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  private balance: bigint;
  constructor(opts: { address?: string; initialBalanceAtomic?: string } = {}) {
    this.address = opts.address ?? "rDemoXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    this.publicKeyHex = "ED" + "00".repeat(32);
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    currency?: string;
    destinationTag?: string;
  }) {
    const sig = "DEMOSIG_" + (input.destinationTag ?? input.recipient).slice(0, 16);
    return {
      signatureHex: sig,
      publicKeyHex: this.publicKeyHex,
      hash: sig,
      ledgerIndex: 1,
      explorerUrl: `https://testnet.xrpl.org/transactions/${sig}`,
    };
  }
  async getBalance(): Promise<bigint> {
    return this.balance;
  }
  /** Test helper. */
  setBalance(atomic: string) {
    this.balance = BigInt(atomic);
  }
}

// ============================================================================
//  InstrumentStore
// ============================================================================

export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(id: InstrumentId): Promise<Instrument | undefined>;
}

export class MemoryInstrumentStore implements InstrumentStore {
  private byUser = new Map<string, Instrument>();
  private byId = new Map<string, Instrument>();
  async get(userId: UserId) {
    return this.byUser.get(userId);
  }
  async put(instrument: Instrument) {
    this.byUser.set(instrument.userId, instrument);
    this.byId.set(instrument.id, instrument);
  }
  async getById(id: InstrumentId) {
    return this.byId.get(id);
  }
}

// ============================================================================
//  WalletConnector
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "XRP", decimals: XRP_DECIMALS },
];

export interface RippleConnectorConfig {
  readonly signer: RippleSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet" | "devnet";
  readonly now?: () => number;
}

export class RippleConnector implements WalletConnector {
  private readonly signer: RippleSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet" | "devnet";
  private readonly now: () => number;

  constructor(cfg: RippleConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Ripple / XRP Ledger (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 4000, // ~3-5s ledger close on XRPL
      features: {
        nonEvm: true,
        ed25519: true,
        base58check: true,
        xrpl: true,
        network: this.network,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    const existing = await this.store.get(input.userId);
    if (existing) return existing;
    const id = `payment-instrument-ripple-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        publicKeyHex: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance("XRP");
    return {
      instrumentId: inst.id,
      asset: { symbol: "XRP", decimals: XRP_DECIMALS },
      money: {
        amountAtomic: atomic.toString(),
        decimals: XRP_DECIMALS,
        currency: "XRP",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * An XRPL Payment is single-step at the wire level: build + sign a Payment op.
   * We split the flow to fit the 5-method interface: signAuthorization() builds
   * + signs the intent (and broadcasts iff the signer has a submit hook),
   * settle() adapts the result. Same pattern as wallet-solana / wallet-stellar.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `RippleConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const isNative = input.request.asset.symbol === "XRP";
    const currency = isNative ? undefined : input.request.asset.symbol;

    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(currency !== undefined ? { currency } : {}),
      destinationTag: input.request.nonce,
    });

    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signatureHex,
      extra: {
        network: this.network,
        publicKeyHex: result.publicKeyHex,
        ...(result.hash !== undefined ? { hash: result.hash } : {}),
        ...(result.ledgerIndex !== undefined
          ? { ledgerIndex: result.ledgerIndex }
          : {}),
        explorerUrl: result.explorerUrl ?? "",
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `ripple-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing XRPL signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    // Prefer the real ledger tx hash if broadcast happened; else the signature.
    const ref = (typeof e["hash"] === "string" && e["hash"]
      ? (e["hash"] as string)
      : signed.signature) as TransactionRef;
    return {
      success: true,
      transactionRef: ref,
      network: `ripple-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        ledgerIndex: e["ledgerIndex"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) throw new Error(`Instrument not found: ${id}`);
    return i;
  }
}

// ============================================================================
//  Helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}

/** Convert a decimal string like "1.5" with `decimals=6` → "1500000" drops. */
export function decimalToDrops(decimal: string, decimals = XRP_DECIMALS): string {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new Error(`Invalid decimal amount: ${decimal}`);
  }
  const [whole = "0", frac = ""] = decimal.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole + fracPadded).replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

// re-export Money for convenience
export type { Money };
