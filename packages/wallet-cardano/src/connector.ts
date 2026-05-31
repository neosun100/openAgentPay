/**
 * Cardano (Shelley) Wallet Connector
 * ==================================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for the
 * Cardano network — Ed25519 keys, blake2b-224 credential hashes, bech32
 * "addr_test1…" enterprise addresses, and 6-decimal native assets (ADA in
 * lovelace, plus the USDM stablecoin).
 *
 *   - Account model: EVM nonces → Cardano eUTxO (stateless authorization here)
 *   - Crypto: secp256k1 ECDSA (EVM) → Ed25519 (Cardano / Shelley)
 *   - Hash: keccak256 (EVM) → blake2b-224 (key hash) / blake2b-256 (tx body)
 *   - Recipient: 0x… (EVM) → bech32 addr_test1… (Cardano)
 *   - Settlement: smart-contract call (EVM) → Tx submit (node / Blockfrost)
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Implementation strategy: PURE TypeScript (no cardano-serialization-lib).
 * Real signing via RealCardanoSigner (@noble/curves Ed25519 + @noble/hashes
 * blake2b). On-chain broadcast is behind a pluggable `submit` hook on the
 * signer, defaulting to offline-safe (deterministic mock tx ref).
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

import {
  RealCardanoSigner,
  canonicalTransferDescriptor,
  type CardanoNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "cardano-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "cardano" as WalletProviderId;
export const X_PAYMENT_CARDANO_HEADER = "X-PAYMENT-CARDANO";

/** USDM (Mehen) policy id on Cardano — used as the canonical stablecoin asset. */
const USDM_ASSET_UNIT =
  "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d";

/** ADA / native asset uses 6 decimals (1 ADA = 1_000_000 lovelace). */
const CARDANO_DECIMALS = 6;

// ============================================================================
//  Cardano signer abstraction (pluggable)
// ============================================================================

export interface CardanoSigner {
  /** bech32 address ("addr_test1…" / "addr1…"). */
  readonly address: string;
  /** Hex Ed25519 public key. */
  readonly publicKeyHex: string;
  /** Network the signer is bound to. */
  readonly network: CardanoNetwork;
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly asset?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signatureHex: string;
    readonly txHash?: string;
    readonly slot?: number;
    readonly explorerUrl?: string;
  }>;
  getBalance(asset?: string): Promise<bigint>;
  verify(signatureHex: string, descriptor: string): boolean;
}

/**
 * In-memory signer for unit tests. Produces a deterministic fake signature —
 * never used in production. The conformance suite uses RealCardanoSigner.
 */
export class DemoCardanoSigner implements CardanoSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  readonly network: CardanoNetwork;
  private balance: bigint;
  constructor(
    opts: {
      address?: string;
      publicKeyHex?: string;
      network?: CardanoNetwork;
      initialBalanceAtomic?: string;
    } = {}
  ) {
    this.network = opts.network ?? "testnet";
    this.address =
      opts.address ??
      "addr_test1vqe0000000000000000000000000000000000000000000000000000";
    this.publicKeyHex = opts.publicKeyHex ?? "00".repeat(32);
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    asset?: string;
    memo?: string;
  }) {
    const sig = "DEMOSIG_" + (input.memo ?? input.recipient).slice(0, 16);
    return {
      signatureHex: sig,
      txHash: sig,
      slot: 1,
      explorerUrl: `https://preprod.cardanoscan.io/transaction/${sig}`,
    };
  }
  async getBalance(): Promise<bigint> {
    return this.balance;
  }
  verify(): boolean {
    return true;
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
  { symbol: "ADA", decimals: CARDANO_DECIMALS },
  { symbol: "USDM", decimals: CARDANO_DECIMALS, contract: USDM_ASSET_UNIT },
];

export interface CardanoConnectorConfig {
  readonly signer: CardanoSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: CardanoNetwork;
  /** Default asset unit for balance reads (default "lovelace"). */
  readonly defaultAsset?: string;
  readonly now?: () => number;
}

export class CardanoConnector implements WalletConnector {
  private readonly signer: CardanoSigner;
  private readonly store: InstrumentStore;
  private readonly network: CardanoNetwork;
  private readonly defaultAsset: string;
  private readonly now: () => number;

  constructor(cfg: CardanoConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? cfg.signer.network ?? "testnet";
    this.defaultAsset = cfg.defaultAsset ?? "lovelace";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Cardano (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; light-wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 20_000, // ~20s block time on Cardano
      features: {
        nonEvm: true,
        ed25519: true,
        eUtxo: true,
        nativeAda: true,
        nativeTokens: true,
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
    const id = `payment-instrument-cardano-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultAsset: this.defaultAsset,
        publicKeyHex: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultAsset);
    const isUsdm = this.defaultAsset === USDM_ASSET_UNIT;
    return {
      instrumentId: inst.id,
      asset: isUsdm
        ? { symbol: "USDM", decimals: CARDANO_DECIMALS, contract: USDM_ASSET_UNIT }
        : { symbol: "ADA", decimals: CARDANO_DECIMALS },
      money: {
        amountAtomic: atomic.toString(),
        decimals: CARDANO_DECIMALS,
        currency: isUsdm ? "USDM" : "ADA",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Cardano is single-step at the wire level (build + sign + submit a Tx).
   * We split the flow to fit the 5-method interface: signAuthorization()
   * produces the real Ed25519 authorization (broadcast deferred unless a
   * `submit` hook is wired), settle() adapts the receipt.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `CardanoConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const assetUnit =
      input.request.asset.contract ??
      (input.request.asset.symbol === "USDM" ? USDM_ASSET_UNIT : "lovelace");
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(assetUnit !== "lovelace" ? { asset: assetUnit } : {}),
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    // The exact descriptor we signed — exposed so verifiers can re-check.
    const descriptor = canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      network: this.network,
      ...(assetUnit !== "lovelace" ? { asset: assetUnit } : {}),
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signatureHex,
      extra: {
        publicKeyHex: this.signer.publicKeyHex,
        descriptor,
        network: this.network,
        ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
        ...(result.slot !== undefined ? { slot: result.slot } : {}),
        ...(result.explorerUrl !== undefined
          ? { explorerUrl: result.explorerUrl }
          : {}),
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `cardano-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing Ed25519 signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    // On-chain tx hash if a submit hook ran; otherwise a deterministic offline
    // reference derived from the (real) signature so the receipt is stable.
    const txHash =
      typeof e["txHash"] === "string" && e["txHash"]
        ? (e["txHash"] as string)
        : `offline-${signed.signature.slice(0, 32)}`;
    return {
      success: true,
      transactionRef: txHash as TransactionRef,
      network: `cardano-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        slot: e["slot"],
        explorerUrl: e["explorerUrl"],
        broadcast: typeof e["txHash"] === "string",
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

// Re-export the real signer alongside the connector for convenience.
export { RealCardanoSigner };
