/**
 * Algorand WalletConnector
 * ========================
 *
 * Non-EVM connector for the Algorand chain, proving the 5-method
 * WalletConnector contract holds across yet another chain model:
 *
 *   - Crypto: Ed25519 (like Solana/Stellar), distinct from EVM secp256k1.
 *   - Address: base32(pubkey || sha512_256(pubkey)[-4:]), 58 chars, UPPERCASE
 *     — a checksum address, unlike Solana's bare base58 pubkey.
 *   - Assets: native ALGO (6 dp) + ASA tokens like USDC (6 dp, asset-id 31566704
 *     on MainNet / 10458941 on TestNet).
 *   - Settlement: algod `sendRawTransaction` (kept behind a pluggable submit
 *     hook; offline-safe deterministic mock by default).
 *
 * Protocol: "algorand-pay-v1". Signing produces a real Ed25519 signature over
 * a canonical transfer descriptor (see real-signer.ts).
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

import { canonicalTransferDescriptor } from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "algorand-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "algorand" as WalletProviderId;

/** USDC ASA asset-ids. */
const USDC_ASSET_ID_MAINNET = 31566704;
const USDC_ASSET_ID_TESTNET = 10458941;

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "ALGO", decimals: 6 },
  { symbol: "USDC", decimals: 6 },
];

// ============================================================================
//  Algorand signer abstraction (pluggable)
// ============================================================================

export interface AlgorandSigner {
  /** 58-char uppercase base32 Algorand address. */
  readonly address: string;
  /**
   * Sign (and optionally submit) an Algorand transfer. Implementations:
   *   - RealAlgorandSigner (real-signer.ts) — real Ed25519 sig, offline-safe
   *   - algosdk-based signer (production) — real broadcast via algod
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly assetId?: number;
    readonly note?: string;
  }): Promise<{
    readonly signatureB64: string;
    readonly txId?: string;
    readonly round?: number;
  }>;
  getBalance(assetId?: number): Promise<bigint>;
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

export interface AlgorandConnectorConfig {
  readonly signer: AlgorandSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet" | "betanet";
  /** ASA asset-id used for default (USDC) balance reads. */
  readonly defaultAssetId?: number;
  readonly now?: () => number;
}

export class AlgorandConnector implements WalletConnector {
  private readonly signer: AlgorandSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet" | "betanet";
  private readonly defaultAssetId: number;
  private readonly now: () => number;

  constructor(cfg: AlgorandConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultAssetId =
      cfg.defaultAssetId ??
      (this.network === "mainnet"
        ? USDC_ASSET_ID_MAINNET
        : USDC_ASSET_ID_TESTNET);
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Algorand (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; mobile-wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 3000, // ~2.8s block finality on Algorand
      features: {
        nonEvm: true,
        ed25519: true,
        nativeAlgo: true,
        asa: true,
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
    const id = `payment-instrument-algorand-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultAssetId: this.defaultAssetId,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultAssetId);
    return {
      instrumentId: inst.id,
      asset: {
        symbol: "USDC",
        decimals: 6,
        contract: String(this.defaultAssetId),
      },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Algorand signing produces a real Ed25519 signature over the transfer
   * descriptor. Like Solana, settlement is effectively single-shot at the
   * chain layer; we split into sign + settle to fit the 5-method interface.
   * signAuthorization() computes the signature (and, when a submit hook is
   * present, broadcasts); settle() adapts the result into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `AlgorandConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const assetId =
      input.request.asset.contract !== undefined
        ? Number(input.request.asset.contract)
        : input.request.asset.symbol === "ALGO"
          ? undefined
          : this.defaultAssetId;

    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(assetId !== undefined && Number.isFinite(assetId) ? { assetId } : {}),
      ...(input.request.description !== undefined
        ? { note: input.request.description }
        : {}),
    });

    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signatureB64,
      extra: {
        ...(result.txId !== undefined ? { txId: result.txId } : {}),
        round: result.round ?? 0,
        network: this.network,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `algorand-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing Ed25519 signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const txId = typeof e["txId"] === "string" ? (e["txId"] as string) : undefined;
    const ref = txId ?? signed.signature;
    return {
      success: true,
      transactionRef: ref as TransactionRef,
      network: `algorand-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        ...(txId !== undefined ? { txId } : {}),
        round: e["round"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Reconstruct the canonical descriptor a SignedAuthorization signed over. */
  descriptorFor(signed: SignedAuthorization): string {
    const r = signed.request;
    const assetId =
      r.asset.contract !== undefined
        ? Number(r.asset.contract)
        : r.asset.symbol === "ALGO"
          ? undefined
          : this.defaultAssetId;
    return canonicalTransferDescriptor({
      from: signed.signer,
      to: r.recipient,
      amountAtomic: r.amount.amountAtomic,
      ...(assetId !== undefined && Number.isFinite(assetId) ? { assetId } : {}),
      ...(r.description !== undefined ? { note: r.description } : {}),
    });
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
