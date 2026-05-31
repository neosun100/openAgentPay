/**
 * Sui Pay Protocol Adapter scaffolding + Wallet Connector
 * ========================================================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for Sui:
 *
 *   - Account model: object-centric (Sui owns Coin<T> objects) vs EVM balances
 *   - Crypto: Ed25519 with a scheme-flag-prefixed blake2b-256 address
 *   - Recipient: 0x + 64 hex (blake2b digest) vs EVM 0x + 40 hex (keccak)
 *   - Settlement: TransactionBlock w/ Coin::split + transfer vs ERC-20 call
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Implementation strategy: PURE TypeScript via the pluggable `SuiSigner`
 * interface (see real-signer.ts). Real Ed25519 signing offline; broadcast
 * deferred to an optional `submit` hook backed by @mysten/sui in production.
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
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

export const PROTOCOL_ID = "sui-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "sui" as WalletProviderId;
export const X_PAYMENT_SUI_HEADER = "X-PAYMENT-SUI";

/** Canonical native SUI coin type. */
export const SUI_COIN_TYPE = "0x2::sui::SUI";
/** Circle USDC on Sui testnet (coin type). */
export const SUI_USDC_TESTNET =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

// ============================================================================
//  Sui signer abstraction (pluggable)
// ============================================================================

export interface SuiSigner {
  /** Sui address — "0x" + 64 hex chars. */
  readonly address: string;
  /** Ed25519 public key, hex (no 0x). */
  readonly publicKeyHex: string;
  /**
   * Sign + (optionally) submit a Sui transfer. Implementations:
   *   - RealSuiSigner (real-signer.ts) — real Ed25519 signature, deferred broadcast
   *   - @mysten/sui based signer (production) — assembles + executes a TransactionBlock
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly coinType?: string;
    readonly reference?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signature: string;
    readonly digest?: string;
    readonly explorerUrl?: string;
  }>;
  getBalance(coinType?: string): Promise<bigint>;
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
  { symbol: "SUI", decimals: 9 },
  { symbol: "USDC", decimals: 6 },
];

export interface SuiConnectorConfig {
  readonly signer: SuiSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet" | "devnet";
  readonly defaultCoinType?: string;
  readonly now?: () => number;
}

export class SuiConnector implements WalletConnector {
  private readonly signer: SuiSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet" | "devnet";
  private readonly defaultCoinType: string;
  private readonly now: () => number;

  constructor(cfg: SuiConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultCoinType = cfg.defaultCoinType ?? SUI_COIN_TYPE;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Sui (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; mobile wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 500, // Sui sub-second finality (Mysticeti)
      features: {
        nonEvm: true,
        ed25519: true,
        objectModel: true,
        nativeSui: true,
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
    const id = `payment-instrument-sui-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultCoinType: this.defaultCoinType,
        publicKeyHex: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultCoinType);
    const isUsdc = this.defaultCoinType === SUI_USDC_TESTNET;
    const decimals = isUsdc ? 6 : 9;
    const symbol = isUsdc ? "USDC" : "SUI";
    return {
      instrumentId: inst.id,
      asset: { symbol, decimals, contract: this.defaultCoinType },
      money: {
        amountAtomic: atomic.toString(),
        decimals,
        currency: symbol,
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sui transfers are single-shot at the chain level (build + sign a
   * TransactionBlock), but we split into sign/settle to fit the 5-method
   * contract. signAuthorization() produces the real Ed25519 authorization;
   * settle() adapts/broadcasts it.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `SuiConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const coinType =
      input.request.asset.contract ??
      (input.request.asset.symbol === "SUI" ? SUI_COIN_TYPE : this.defaultCoinType);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      coinType,
      reference: input.request.nonce,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signature,
      extra: {
        digest: result.digest ?? "",
        explorerUrl: result.explorerUrl ?? "",
        network: this.network,
        coinType,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `sui-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing tx signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const ref = (typeof e["digest"] === "string" && e["digest"]
      ? e["digest"]
      : signed.signature) as TransactionRef;
    return {
      success: true,
      transactionRef: ref,
      network: `sui-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        digest: e["digest"],
        explorerUrl: e["explorerUrl"],
        coinType: e["coinType"],
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
