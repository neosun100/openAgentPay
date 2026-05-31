/**
 * Stellar (SEP-31) Wallet Connector
 * ==================================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for the
 * Stellar network — Ed25519 keys encoded as StrKey ("G..." addresses), 7-decimal
 * assets (XLM, USDC), and SEP-31 cross-border transfer semantics.
 *
 *   - Account model: EVM nonces → Stellar sequence numbers (stateless here)
 *   - Crypto: secp256k1 ECDSA (EVM) → Ed25519 (Stellar)
 *   - Recipient: 0x… (EVM) → StrKey "G…" (Stellar)
 *   - Settlement: smart-contract call (EVM) → SEP-31 payment op (Horizon submit)
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Implementation strategy: PURE TypeScript (no stellar-sdk). Real signing via
 * RealStellarSigner (@noble/curves Ed25519). On-chain broadcast is behind a
 * pluggable `submit` hook on the signer, defaulting to offline-safe.
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

export const PROTOCOL_ID = "stellar-sep31-v1" as import("@openagentpay/core").ProtocolId;
export const WALLET_PROVIDER_ID = "stellar" as WalletProviderId;
export const X_PAYMENT_STELLAR_HEADER = "X-PAYMENT-STELLAR";

/** Circle USDC on Stellar (7 decimals). Issuer is the same on public + testnet aliasing. */
const STELLAR_USDC_ISSUER_PUBLIC =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const STELLAR_USDC_ISSUER_TESTNET =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Stellar uses 7 decimal places for ALL classic assets (XLM + issued). */
const STELLAR_DECIMALS = 7;

// ============================================================================
//  Stellar signer abstraction (pluggable)
// ============================================================================

export interface StellarSigner {
  /** StrKey account id ("G..."). */
  readonly address: string;
  /**
   * Sign + (optionally) submit a SEP-31 transfer. Implementations:
   *   - DemoStellarSigner (this file) — fake signature for tests
   *   - RealStellarSigner (real-signer.ts) — real Ed25519, pluggable broadcast
   *   - stellar-sdk based signer (production)
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly assetCode?: string;
    readonly assetIssuer?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signatureHex: string;
    readonly hash?: string;
    readonly ledger?: number;
    readonly explorerUrl?: string;
  }>;
  getBalance(assetCode?: string): Promise<bigint>;
}

/**
 * In-memory signer for unit tests. Produces a deterministic-ish fake signature —
 * never used in production. The conformance suite uses RealStellarSigner.
 */
export class DemoStellarSigner implements StellarSigner {
  readonly address: string;
  private balance: bigint;
  constructor(opts: { address?: string; initialBalanceAtomic?: string } = {}) {
    this.address =
      opts.address ??
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF7";
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    assetCode?: string;
    memo?: string;
  }) {
    const sig =
      "DEMOSIG_" + (input.memo ?? input.recipient).slice(0, 16);
    return {
      signatureHex: sig,
      hash: sig,
      ledger: 1,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${sig}`,
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
  { symbol: "XLM", decimals: STELLAR_DECIMALS },
  { symbol: "USDC", decimals: STELLAR_DECIMALS },
];

export interface StellarConnectorConfig {
  readonly signer: StellarSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "public" | "testnet";
  /** Default issued-asset code when the request asks for a non-native asset. */
  readonly defaultAssetCode?: string;
  readonly defaultAssetIssuer?: string;
  readonly now?: () => number;
}

export class StellarConnector implements WalletConnector {
  private readonly signer: StellarSigner;
  private readonly store: InstrumentStore;
  private readonly network: "public" | "testnet";
  private readonly defaultAssetCode: string;
  private readonly defaultAssetIssuer: string;
  private readonly now: () => number;

  constructor(cfg: StellarConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultAssetCode = cfg.defaultAssetCode ?? "USDC";
    this.defaultAssetIssuer =
      cfg.defaultAssetIssuer ??
      (this.network === "public"
        ? STELLAR_USDC_ISSUER_PUBLIC
        : STELLAR_USDC_ISSUER_TESTNET);
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Stellar (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 5000, // ~5s ledger close on Stellar
      features: {
        nonEvm: true,
        ed25519: true,
        strkey: true,
        sep31: true,
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
    const id = `payment-instrument-stellar-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultAssetCode: this.defaultAssetCode,
        defaultAssetIssuer: this.defaultAssetIssuer,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultAssetCode);
    return {
      instrumentId: inst.id,
      asset: {
        symbol: this.defaultAssetCode,
        decimals: STELLAR_DECIMALS,
        contract: this.defaultAssetIssuer,
      },
      money: {
        amountAtomic: atomic.toString(),
        decimals: STELLAR_DECIMALS,
        currency: this.defaultAssetCode,
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * SEP-31 transfer is single-step at the wire level: build + sign a payment op.
   * We split the flow to fit the 5-method interface: signAuthorization() builds
   * + signs the intent (and broadcasts iff the signer has a submit hook),
   * settle() adapts the result. Same pattern as wallet-solana.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `StellarConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const isNative = input.request.asset.symbol === "XLM";
    const assetCode = isNative ? undefined : input.request.asset.symbol;
    const assetIssuer = isNative
      ? undefined
      : input.request.asset.contract ?? this.defaultAssetIssuer;

    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(assetCode !== undefined ? { assetCode } : {}),
      ...(assetIssuer !== undefined ? { assetIssuer } : {}),
      memo: input.request.nonce,
    });

    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signatureHex,
      extra: {
        network: this.network,
        ...(result.hash !== undefined ? { hash: result.hash } : {}),
        ...(result.ledger !== undefined ? { ledger: result.ledger } : {}),
        explorerUrl: result.explorerUrl ?? "",
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `stellar-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing Stellar signature",
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
      network: `stellar-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        ledger: e["ledger"],
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

/** Convert a decimal string like "1.5" with `decimals=7` → "15000000". */
export function decimalToAtomic(decimal: string, decimals = STELLAR_DECIMALS): string {
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
