/**
 * Celestia Wallet Connector
 * =========================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for the
 * Celestia modular data-availability (DA) chain — a Cosmos SDK chain:
 *
 *   - Crypto: secp256k1 ECDSA (compressed pubkeys) — same curve as Cosmos Hub.
 *   - Identity: 24-word BIP39 mnemonic → BIP44 m/44'/118'/0'/0/0.
 *   - Address: bech32 "celestia1…" (vs cosmos1… / EVM 0x… / Solana base58).
 *   - Settlement: bank MsgSend (vs EVM contract call).
 *   - Native asset: TIA (utia, 6 decimals).
 *
 * Satisfies the identical 5-method WalletConnector contract.
 *
 * Implementation: pure TypeScript signing through `RealCelestiaSigner`. On-chain
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
  ProtocolId,
  SettlementResult,
  SignAuthorizationInput,
  SignedAuthorization,
  TransactionRef,
  UserId,
  WalletCapabilities,
  WalletConnector,
  WalletProviderId,
} from "@openagentpay/core";

import {
  RealCelestiaSigner,
  canonicalTransferDescriptor,
  CELESTIA_BECH32_PREFIX,
  TIA_DENOM,
  USDC_DENOM,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "celestia-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "celestia" as WalletProviderId;

/** Canonical denom for the native TIA token (micro-TIA). */
export const TIA_NATIVE_DENOM = TIA_DENOM;
/** USDC denom on Celestia (micro-USDC). */
export const USDC_NATIVE_DENOM = USDC_DENOM;

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "TIA", decimals: 6 },
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

export interface CelestiaConnectorConfig {
  readonly signer: RealCelestiaSigner;
  readonly instrumentStore: InstrumentStore;
  /** Chain id label for capabilities / settlement (default from signer). */
  readonly chainId?: string;
  /** Default denom to read for getBalance() (default "utia"). */
  readonly defaultDenom?: string;
  readonly now?: () => number;
}

export class CelestiaConnector implements WalletConnector {
  private readonly signer: RealCelestiaSigner;
  private readonly store: InstrumentStore;
  private readonly chainId: string;
  private readonly defaultDenom: string;
  private readonly now: () => number;

  constructor(cfg: CelestiaConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.chainId = cfg.chainId ?? cfg.signer.chainId;
    this.defaultDenom = cfg.defaultDenom ?? TIA_NATIVE_DENOM;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Celestia (${this.chainId})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side mnemonic signer
      settlesOnChain: true,
      typicalLatencyMs: 6000, // ~6s block times
      features: {
        nonEvm: true,
        secp256k1: true,
        bech32Prefix: this.signer.prefix,
        modularDA: true,
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
    const id = `payment-instrument-celestia-${input.userId}` as InstrumentId;
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
    const symbol = this.defaultDenom === USDC_NATIVE_DENOM ? "USDC" : "TIA";
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
   * Celestia transfers are single-shot (build → sign → broadcast). We split the
   * flow to fit the 5-method contract: signAuthorization() produces the real
   * secp256k1 authorization (and broadcasts if a `submit` hook is wired);
   * settle() returns the result.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `CelestiaConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
        network: `celestia-${this.chainId}`,
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
      network: `celestia-${this.chainId}`,
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
    if (symbol === "USDC") return USDC_NATIVE_DENOM;
    if (symbol === "TIA") return TIA_NATIVE_DENOM;
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
export { CELESTIA_BECH32_PREFIX };
