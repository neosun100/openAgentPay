/**
 * Polkadot (SS58 / Ed25519) Wallet Connector
 * ===========================================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for the
 * Substrate / Polkadot family — Ed25519 keys encoded as SS58 ("1..." Polkadot,
 * "5..." Substrate generic), 10-decimal DOT, 6-decimal USDt (Asset Hub), and
 * a "polkadot-pay-v1" settlement semantics.
 *
 *   - Account model: EVM nonces → Substrate account nonce (stateless here)
 *   - Crypto: secp256k1 ECDSA (EVM) → Ed25519 (Polkadot ed25519 key variant)
 *   - Recipient: 0x… (EVM) → SS58 base58 string (Polkadot)
 *   - Settlement: smart-contract call (EVM) → balances/assets pallet extrinsic
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Implementation strategy: PURE TypeScript (no @polkadot/api). Real signing via
 * RealPolkadotSigner (@noble/curves Ed25519 + SS58 codec). On-chain broadcast is
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
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type TransactionRef,
  type ProtocolId,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "polkadot-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "polkadot" as WalletProviderId;
export const X_PAYMENT_POLKADOT_HEADER = "X-PAYMENT-POLKADOT";

/** DOT (relay-chain native token) uses 10 decimal places. */
export const DOT_DECIMALS = 10;
/** USDt on Polkadot Asset Hub (asset id 1984) uses 6 decimal places. */
export const USDT_DECIMALS = 6;

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "DOT", decimals: DOT_DECIMALS },
  { symbol: "USDt", decimals: USDT_DECIMALS },
];

// ============================================================================
//  Polkadot signer abstraction (pluggable)
// ============================================================================

export interface PolkadotSigner {
  /** SS58 address ("1..." Polkadot or "5..." Substrate generic). */
  readonly address: string;
  /**
   * Sign + (optionally) submit a transfer. Implementations:
   *   - DemoPolkadotSigner (this file) — fake signature for tests
   *   - RealPolkadotSigner (real-signer.ts) — real Ed25519, pluggable broadcast
   *   - @polkadot/api based signer (production)
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly assetSymbol?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signatureHex: string;
    readonly blockHash?: string;
    readonly explorerUrl?: string;
  }>;
  getBalance(assetSymbol?: string): Promise<bigint>;
}

/**
 * In-memory signer for unit tests. Produces a deterministic-ish fake signature —
 * never used in production. The conformance suite uses RealPolkadotSigner.
 */
export class DemoPolkadotSigner implements PolkadotSigner {
  readonly address: string;
  private balance: bigint;
  constructor(opts: { address?: string; initialBalanceAtomic?: string } = {}) {
    this.address =
      opts.address ??
      "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // Alice (well-known dev key)
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    assetSymbol?: string;
    memo?: string;
  }) {
    const sig = "deadbeef" + (input.memo ?? input.recipient).slice(0, 16);
    return {
      signatureHex: sig,
      blockHash: "0x" + sig,
      explorerUrl: `https://westend.subscan.io/extrinsic/0x${sig}`,
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

export interface PolkadotConnectorConfig {
  readonly signer: PolkadotSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network label used in capabilities + settlement result. Default "westend". */
  readonly network?: string;
  /** Default asset symbol used for getBalance(). Default "DOT". */
  readonly defaultAsset?: string;
  readonly now?: () => number;
}

export class PolkadotConnector implements WalletConnector {
  private readonly signer: PolkadotSigner;
  private readonly store: InstrumentStore;
  private readonly network: string;
  private readonly defaultAsset: string;
  private readonly now: () => number;

  constructor(cfg: PolkadotConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "westend";
    this.defaultAsset = cfg.defaultAsset ?? "DOT";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Polkadot (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; mobile-wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 12000, // ~6s blocks, ~2 blocks to inclusion+finality signal
      features: {
        nonEvm: true,
        ed25519: true, // we use the Ed25519 Polkadot key variant, not sr25519
        ss58: true,
        substrate: true,
        nativeDot: true,
        assetHubUsdt: true,
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
    const id = `payment-instrument-polkadot-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultAsset: this.defaultAsset,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultAsset);
    const decimals = this.defaultAsset === "USDt" ? USDT_DECIMALS : DOT_DECIMALS;
    return {
      instrumentId: inst.id,
      asset: { symbol: this.defaultAsset, decimals },
      money: {
        amountAtomic: atomic.toString(),
        decimals,
        currency: this.defaultAsset,
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Polkadot settlement is single-step at the chain layer (one signed
   * extrinsic). We split it across our 5-method interface: signAuthorization()
   * produces the real Ed25519 signature over the transfer intent (and, when a
   * `submit` hook is wired, broadcasts); settle() adapts the result.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `PolkadotConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const assetSymbol = input.request.asset.symbol || this.defaultAsset;
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      assetSymbol,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signatureHex,
      extra: {
        blockHash: result.blockHash ?? "",
        explorerUrl: result.explorerUrl ?? "",
        network: this.network,
        assetSymbol,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `polkadot-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const ref =
      typeof e["blockHash"] === "string" && e["blockHash"]
        ? (e["blockHash"] as string)
        : signed.signature;
    return {
      success: true,
      transactionRef: ref as TransactionRef,
      network: `polkadot-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        signatureHex: signed.signature,
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
