/**
 * Initia Wallet Connector
 * =======================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for Initia —
 * a Cosmos-SDK "interwoven rollup" L1:
 *
 *   - Crypto: secp256k1 ECDSA (compressed pubkeys).
 *   - Identity: 24-word BIP39 mnemonic → BIP44 m/44'/118'/0'/0/0.
 *   - Address: bech32 "init1…" (vs cosmos1… / EVM 0x… / Solana base58).
 *   - Settlement: bank MsgSend (vs EVM contract call).
 *   - Assets: INIT (uinit, 6 dp — native gas), USDC (6 dp, bridged).
 *
 * Still satisfies the identical 5-method WalletConnector contract.
 *
 * Implementation: pure TypeScript signing through `RealInitiaSigner`. On-chain
 * broadcast is pluggable via the signer's optional `submit` hook — defaulting
 * to an offline-safe path so conformance + unit tests run without a network.
 *
 * @license Apache-2.0
 */

import type {
  Asset,
  Balance,
  CreateInstrumentInput,
  Instrument,
  InstrumentId,
  SettlementResult,
  SignAuthorizationInput,
  SignedAuthorization,
  TransactionRef,
  UserId,
  WalletCapabilities,
  WalletConnector,
  WalletProviderId,
  ProtocolId,
} from "@openagentpay/core";

import {
  RealInitiaSigner,
  canonicalTransferDescriptor,
  INITIA_BECH32_PREFIX,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "initia-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "initia" as WalletProviderId;

/** Canonical denom for native gas/staking token on Initia. */
export const INIT_DENOM = "uinit";
/** USDC bridges into Initia; denom is an IBC/bridge hash in production. */
export const USDC_DENOM = "uusdc";

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "INIT", decimals: 6 },
  { symbol: "USDC", decimals: 6 },
];

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

export interface InitiaConnectorConfig {
  readonly signer: RealInitiaSigner;
  readonly instrumentStore: InstrumentStore;
  /** Chain id label for capabilities / settlement (default from signer). */
  readonly chainId?: string;
  /** Default denom to read for getBalance() (default "uinit"). */
  readonly defaultDenom?: string;
  readonly now?: () => number;
}

export class InitiaConnector implements WalletConnector {
  private readonly signer: RealInitiaSigner;
  private readonly store: InstrumentStore;
  private readonly chainId: string;
  private readonly defaultDenom: string;
  private readonly now: () => number;

  constructor(cfg: InitiaConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.chainId = cfg.chainId ?? cfg.signer.chainId;
    this.defaultDenom = cfg.defaultDenom ?? INIT_DENOM;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Initia (${this.chainId})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side mnemonic signer
      settlesOnChain: true,
      typicalLatencyMs: 2000, // ~sub-second to ~2s block times on Initia
      features: {
        nonEvm: true,
        secp256k1: true,
        bech32Prefix: this.signer.prefix,
        cosmosSdk: true,
        chainId: this.chainId,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    const existing = await this.store.get(input.userId);
    if (existing) return existing;
    const id = `payment-instrument-initia-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        chainId: this.chainId,
        bech32Prefix: this.signer.prefix,
        pubkeyHex: this.signer.publicKeyHex,
        defaultDenom: this.defaultDenom,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultDenom);
    const symbol = this.defaultDenom === USDC_DENOM ? "USDC" : "INIT";
    return {
      instrumentId: inst.id,
      asset: { symbol, decimals: 6 },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: symbol,
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Initia transfers are single-shot (build → sign → broadcast). We split the
   * flow to fit the 5-method contract: signAuthorization() produces the real
   * secp256k1 authorization (and broadcasts if a `submit` hook is wired);
   * settle() returns the result.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `InitiaConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const denom = this.denomForAsset(input.request.asset.symbol);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      denom,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signature,
      extra: {
        pubkeyHex: this.signer.publicKeyHex,
        denom,
        chainId: this.chainId,
        ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
        ...(result.height !== undefined ? { height: result.height } : {}),
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
        network: `initia-${this.chainId}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing transfer signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    // On-chain tx hash if broadcast happened; else fall back to the signature
    // as the local authorization reference (offline-safe).
    const txRef = (typeof e["txHash"] === "string" && e["txHash"]
      ? (e["txHash"] as string)
      : signed.signature) as TransactionRef;
    return {
      success: true,
      transactionRef: txRef,
      network: `initia-${this.chainId}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        denom: e["denom"],
        height: e["height"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Re-derive the canonical descriptor for a signed request (for audit/verify). */
  descriptorFor(signed: SignedAuthorization): string {
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const denom =
      typeof e["denom"] === "string"
        ? (e["denom"] as string)
        : this.denomForAsset(signed.request.asset.symbol);
    return canonicalTransferDescriptor({
      from: signed.signer,
      to: signed.request.recipient,
      amountAtomic: signed.request.amount.amountAtomic,
      denom,
      chainId: this.chainId,
      ...(signed.request.description !== undefined
        ? { memo: signed.request.description }
        : {}),
    });
  }

  private denomForAsset(symbol: string): string {
    if (symbol === "USDC") return USDC_DENOM;
    if (symbol === "INIT") return INIT_DENOM;
    return this.defaultDenom;
  }

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

// Re-export the prefix constant so consumers don't need the signer module.
export { INITIA_BECH32_PREFIX };
