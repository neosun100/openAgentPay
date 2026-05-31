/**
 * NEAR Protocol Wallet Connector
 * ===============================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for NEAR:
 *
 *   - Account model: human-readable / implicit accounts (not 0x addresses)
 *   - Crypto: Ed25519 (like Solana / Stellar; unlike EVM's secp256k1)
 *   - Address: implicit account = lowercase hex(pubkey), 64 chars, no 0x
 *   - Asset: NEAR (24 decimals!) + USDC (6 decimals, NEP-141 token)
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Implementation strategy: PURE TypeScript (no near-api-js dependency) for the
 * identity + signing path. Real signing is via the Ed25519 `NearSigner`
 * interface; on-chain broadcast is pluggable behind RealNearSigner's `submit`
 * hook, defaulting offline-safe.
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
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
  type ProtocolId,
} from "@openagentpay/core";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "near-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "near" as WalletProviderId;

/** USDC on NEAR (NEP-141) — 6 decimals. NEAR native — 24 decimals (yocto). */
export const NEAR_DECIMALS = 24;
export const USDC_DECIMALS = 6;
const NEAR_USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

// ============================================================================
//  NEAR signer abstraction (pluggable)
// ============================================================================

export interface NearSigner {
  /** NEAR account id (implicit hex account, or a named ".testnet" account). */
  readonly accountId: string;
  /** Public key string ("ed25519:" + base58(pubkey)). */
  readonly publicKey: string;
  /**
   * Sign + (optionally) submit a NEAR transfer. Implementations:
   *   - DemoNearSigner (this file) — fake signature for tests
   *   - RealNearSigner (real-signer.ts) — real Ed25519, pluggable broadcast
   *   - near-api-js based signer (production)
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly token?: string;
    readonly reference?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signature: string;
    readonly blockHash?: string;
    readonly explorerUrl?: string;
  }>;
  getBalance(token?: string): Promise<bigint>;
}

/**
 * In-memory signer for tests. Generates a deterministic-ish signature by
 * concatenating inputs — never used in production.
 */
export class DemoNearSigner implements NearSigner {
  readonly accountId: string;
  readonly publicKey: string;
  private balance: bigint;
  constructor(
    opts: {
      accountId?: string;
      publicKey?: string;
      initialBalanceAtomic?: string;
    } = {}
  ) {
    this.accountId =
      opts.accountId ??
      "0000000000000000000000000000000000000000000000000000000000000000";
    this.publicKey = opts.publicKey ?? "ed25519:11111111111111111111111111111111";
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    token?: string;
    reference?: string;
  }) {
    const sig = "DEMOSIG_" + (input.reference ?? input.recipient).slice(0, 16);
    return {
      signature: sig,
      blockHash: "DEMOBLOCK",
      explorerUrl: `https://explorer.testnet.near.org/transactions/${sig}`,
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

// Native NEAR uses 24 decimals (yoctoNEAR); USDC (NEP-141) uses 6. Both are
// within the WalletConnector contract's 24-decimal ceiling (the conformance
// suite explicitly allows up to 24 = NEAR yocto), so both are surfaced here.
// Native-NEAR decimals are also echoed via the `nativeNearDecimals` feature.
const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "NEAR", decimals: NEAR_DECIMALS },
  { symbol: "USDC", decimals: USDC_DECIMALS },
];

export interface NearConnectorConfig {
  readonly signer: NearSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet";
  readonly defaultToken?: string;
  readonly now?: () => number;
}

export class NearConnector implements WalletConnector {
  private readonly signer: NearSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet";
  private readonly defaultToken: string;
  private readonly now: () => number;

  constructor(cfg: NearConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultToken = cfg.defaultToken ?? NEAR_USDC_TESTNET;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `NEAR (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 1500, // ~1.2s NEAR block time + finality
      features: {
        nonEvm: true,
        ed25519: true,
        implicitAccounts: true,
        nativeNear: true,
        nativeNearDecimals: NEAR_DECIMALS,
        nep141: true,
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
    const id = `payment-instrument-near-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.accountId,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        publicKey: this.signer.publicKey,
        defaultToken: this.defaultToken,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultToken);
    return {
      instrumentId: inst.id,
      asset: { symbol: "USDC", decimals: USDC_DECIMALS, contract: this.defaultToken },
      money: {
        amountAtomic: atomic.toString(),
        decimals: USDC_DECIMALS,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `NearConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.accountId) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.accountId}`
      );
    }
    const token =
      input.request.asset.contract ??
      (input.request.asset.symbol === "NEAR" ? undefined : this.defaultToken);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(token !== undefined ? { token } : {}),
      reference: input.request.nonce,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.accountId,
      signature: result.signature,
      extra: {
        publicKey: this.signer.publicKey,
        blockHash: result.blockHash ?? "",
        explorerUrl: result.explorerUrl ?? "",
        network: this.network,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `near-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing tx signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    return {
      success: true,
      transactionRef: signed.signature as TransactionRef,
      network: `near-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        blockHash: e["blockHash"],
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
