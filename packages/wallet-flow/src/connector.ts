/**
 * Flow Wallet Connector
 * =====================
 *
 * WalletConnector implementation for the Flow blockchain (Cadence VM).
 *
 * Flow's model differs from both EVM and Solana:
 *   - Account model: resource-oriented (Cadence), accounts hold multiple keys
 *   - Crypto:        ECDSA secp256k1 (here) or secp256r1 — we use secp256k1
 *   - Address:       8-byte (16-hex) CHAIN-ASSIGNED value, not pubkey-derived
 *   - Settlement:    Cadence `transferTokens` transaction (FlowToken / USDC)
 *
 * It still satisfies the same 5-method WalletConnector contract. The signing
 * identity is real (secp256k1 via @noble/curves); broadcast is pluggable and
 * offline-safe by default — see RealFlowSigner.
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
  canonicalTransferDescriptor,
  RealFlowSigner,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "flow-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "flow" as WalletProviderId;

/** Cadence contract identifiers used as the `asset.contract` discriminator. */
export const FLOW_TOKEN_CONTRACT = "FlowToken";
/** Bridged USDC (Flow EVM / FiatToken). Used as the default stable token. */
export const FLOW_USDC_CONTRACT = "USDCFlow";

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "FLOW", decimals: 8, contract: FLOW_TOKEN_CONTRACT },
  { symbol: "USDC", decimals: 6, contract: FLOW_USDC_CONTRACT },
];

// ============================================================================
//  Pluggable signer abstraction
// ============================================================================

export interface FlowSigner {
  /** Flow account address — "0x" + 16 hex. */
  readonly address: string;
  /** Full uncompressed public key hex (for providerMetadata). */
  readonly publicKeyHex: string;
  /** Flow account-key public-key form (64-byte X||Y hex). */
  readonly flowPublicKeyHex: string;
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly tokenContract?: string;
    readonly reference?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signature: string;
    readonly blockId?: string;
    readonly explorerUrl?: string;
  }>;
  getBalance(tokenContract?: string): Promise<bigint>;
  verify(signatureHex: string, descriptor: string): boolean;
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

export interface FlowConnectorConfig {
  readonly signer: FlowSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet" | "emulator";
  /** Default token contract for getBalance / native transfers. */
  readonly defaultTokenContract?: string;
  readonly now?: () => number;
}

export class FlowConnector implements WalletConnector {
  private readonly signer: FlowSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet" | "emulator";
  private readonly defaultTokenContract: string;
  private readonly now: () => number;

  constructor(cfg: FlowConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultTokenContract = cfg.defaultTokenContract ?? FLOW_TOKEN_CONTRACT;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Flow (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side key; FCL wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 2500, // ~2.5s soft finality on Flow
      features: {
        nonEvm: true,
        cadence: true,
        secp256k1: true,
        nativeFlow: true,
        usdc: true,
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
    const id = `payment-instrument-flow-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address, // "0x" + 16 hex
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultTokenContract: this.defaultTokenContract,
        // Full secp256k1 pubkey preserved here per the chain-assigned-address model.
        publicKeyHex: this.signer.publicKeyHex,
        flowPublicKeyHex: this.signer.flowPublicKeyHex,
        signatureAlgorithm: "ECDSA_secp256k1",
        hashAlgorithm: "SHA2_256",
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const isUsdc = this.defaultTokenContract === FLOW_USDC_CONTRACT;
    const atomic = await this.signer.getBalance(this.defaultTokenContract);
    return {
      instrumentId: inst.id,
      asset: isUsdc
        ? { symbol: "USDC", decimals: 6, contract: FLOW_USDC_CONTRACT }
        : { symbol: "FLOW", decimals: 8, contract: FLOW_TOKEN_CONTRACT },
      money: {
        amountAtomic: atomic.toString(),
        decimals: isUsdc ? 6 : 8,
        currency: isUsdc ? "USDC" : "FLOW",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Build + sign the Flow transfer authorization. The secp256k1 signature is
   * real; the broadcast is deferred to the signer's pluggable `submit` hook
   * (offline-safe by default). settle() adapts the result.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `FlowConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const tokenContract =
      input.request.asset.contract ??
      (input.request.asset.symbol === "FLOW"
        ? FLOW_TOKEN_CONTRACT
        : this.defaultTokenContract);

    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      tokenContract,
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
        blockId: result.blockId ?? "",
        explorerUrl: result.explorerUrl ?? "",
        network: this.network,
        tokenContract,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    // signAuthorization already ran the (pluggable) broadcast — Flow tx is
    // single-shot. Adapt the signed result into a SettlementResult.
    if (!signed.signature) {
      return {
        success: false,
        network: `flow-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing transaction signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    return {
      success: true,
      transactionRef: signed.signature as TransactionRef,
      network: `flow-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        blockId: e["blockId"],
        explorerUrl: e["explorerUrl"],
        tokenContract: e["tokenContract"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Recompute the canonical descriptor for a signed authorization (audit/verify). */
  descriptorFor(signed: SignedAuthorization): string {
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const tokenContract =
      typeof e["tokenContract"] === "string"
        ? (e["tokenContract"] as string)
        : (signed.request.asset.contract ?? FLOW_TOKEN_CONTRACT);
    return canonicalTransferDescriptor({
      from: signed.signer,
      to: signed.request.recipient,
      amountAtomic: signed.request.amount.amountAtomic,
      tokenContract,
      reference: signed.request.nonce,
      ...(signed.request.description !== undefined
        ? { memo: signed.request.description }
        : {}),
    });
  }

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) throw new Error(`Instrument not found: ${id}`);
    return i;
  }
}

// Re-export the default real signer so consumers get a working connector
// out of the box without importing two modules.
export { RealFlowSigner };

// ============================================================================
//  Helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}
