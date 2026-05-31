/**
 * NEAR MAINNET Wallet Connector
 * =============================
 *
 * Mainnet sibling of @openagentpay/wallet-near. Proves the WalletConnector
 * abstraction holds for NEAR mainnet:
 *
 *   - Account model: human-readable ".near" accounts OR implicit accounts
 *     (lowercase hex(pubkey), 64 chars, no 0x) — NOT 0x EVM addresses.
 *   - Crypto: Ed25519 (like Solana / Stellar; unlike EVM's secp256k1)
 *   - Asset: NEAR native (24 decimals, yoctoNEAR) + USDC (6 decimals, NEP-141)
 *
 * Mainnet vs testnet differences (all surfaced here):
 *   - walletProvider = "near-mainnet"
 *   - named accounts end in ".near"
 *   - USDC NEP-141 contract is the Circle-native mainnet token
 *   - explorer / network labels are mainnet
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Implementation strategy: PURE TypeScript (no near-api-js dependency) for the
 * identity + signing path. Real signing is via the Ed25519 `NearMainnetSigner`
 * interface; on-chain broadcast is pluggable behind RealNearMainnetSigner's
 * `submit` hook, defaulting offline-safe.
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
export const WALLET_PROVIDER_ID = "near-mainnet" as WalletProviderId;

/** NEAR native — 24 decimals (yoctoNEAR). USDC on NEAR (NEP-141) — 6 decimals. */
export const NEAR_DECIMALS = 24;
export const USDC_DECIMALS = 6;

/**
 * Circle-native USDC on NEAR mainnet (NEP-141, 6 decimals).
 * Contract account: 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
 */
export const NEAR_USDC_MAINNET =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

// ============================================================================
//  NEAR mainnet signer abstraction (pluggable)
// ============================================================================

export interface NearMainnetSigner {
  /** NEAR account id (implicit hex account, or a named ".near" account). */
  readonly accountId: string;
  /** Public key string ("ed25519:" + base58(pubkey)). */
  readonly publicKey: string;
  /**
   * Sign + (optionally) submit a NEAR transfer. Implementations:
   *   - DemoNearMainnetSigner (this file) — fake signature for tests
   *   - RealNearMainnetSigner (real-signer.ts) — real Ed25519, pluggable broadcast
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
export class DemoNearMainnetSigner implements NearMainnetSigner {
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
      explorerUrl: `https://nearblocks.io/txns/${sig}`,
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
  { symbol: "USDC", decimals: USDC_DECIMALS, contract: NEAR_USDC_MAINNET },
];

export interface NearMainnetConnectorConfig {
  readonly signer: NearMainnetSigner;
  readonly instrumentStore: InstrumentStore;
  readonly defaultToken?: string;
  readonly now?: () => number;
}

export class NearMainnetConnector implements WalletConnector {
  private readonly signer: NearMainnetSigner;
  private readonly store: InstrumentStore;
  private readonly defaultToken: string;
  private readonly now: () => number;

  constructor(cfg: NearMainnetConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.defaultToken = cfg.defaultToken ?? NEAR_USDC_MAINNET;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "NEAR (mainnet)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 1500, // ~1.2s NEAR block time + finality
      features: {
        nonEvm: true,
        ed25519: true,
        implicitAccounts: true,
        namedAccounts: true,
        nativeNear: true,
        nativeNearDecimals: NEAR_DECIMALS,
        nep141: true,
        network: "mainnet",
        mainnet: true,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    const existing = await this.store.get(input.userId);
    if (existing) return existing;
    const id = `payment-instrument-near-mainnet-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.accountId,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: "mainnet",
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
        `NearMainnetConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
        network: "mainnet",
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: "near-mainnet",
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing tx signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    return {
      success: true,
      transactionRef: signed.signature as TransactionRef,
      network: "near-mainnet",
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
