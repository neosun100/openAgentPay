/**
 * Fuel Wallet Connector
 * =====================
 *
 * A WalletConnector for Fuel (FuelVM, testnet by default), backed by a real
 * secp256k1 signer with native b256 address derivation (sha256 of the raw
 * 64-byte public key). Broadcast stays behind the signer's pluggable `submit`
 * hook so signing runs fully offline.
 *
 * Proves the WalletConnector abstraction holds for a novel-VM chain:
 *   - Account model: UTXO-on-FuelVM (coins) addressed by a 32-byte b256 owner
 *   - Crypto: secp256k1 ECDSA over a sha256 digest (Fuel uses sha256, not keccak)
 *   - Address: b256 — `0x` + 64 hex (sha256(pubkey)); NOT base58/bech32/c32check,
 *     NOT a keccak-truncated 20-byte EVM address — the full 32-byte sha256 image
 *   - Assets: ETH (9 decimals, base AssetId = zero b256) + USDC (6 decimals)
 *
 * Single-step settlement model: signAuthorization() builds + signs the transfer
 * intent; settle() adapts that into a SettlementResult.
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
  RealFuelSigner,
  canonicalTransferDescriptor,
  FUEL_BASE_ASSET_ID,
  FUEL_ETH_DECIMALS,
  type FuelNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "fuel-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "fuel" as WalletProviderId;
export const X_PAYMENT_FUEL_HEADER = "X-PAYMENT-FUEL";

/**
 * A non-zero placeholder AssetId for USDC on Fuel testnet. Real deployments
 * resolve the canonical USDC AssetId from the Fuel bridge config; this constant
 * keeps the offline path self-contained and deterministic.
 */
export const FUEL_USDC_ASSET_ID =
  "0xc26b8c9a0e95dc4b04269e6d5fa4cb1908b1e3e3f0b6a5b6e7c8d9e0f1a2b3c4";

const ETH_ASSET: Asset = { symbol: "ETH", decimals: FUEL_ETH_DECIMALS };
const USDC_ASSET: Asset = { symbol: "USDC", decimals: 6 };
const SUPPORTED_ASSETS: readonly Asset[] = [ETH_ASSET, USDC_ASSET];

/** Resolve the Fuel AssetId b256 for a given asset symbol. */
function assetIdForSymbol(symbol: string): string {
  if (symbol === "USDC") return FUEL_USDC_ASSET_ID;
  return FUEL_BASE_ASSET_ID; // ETH / native base asset
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

export interface FuelConnectorConfig {
  readonly signer: RealFuelSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network — defaults to "testnet". */
  readonly network?: FuelNetwork;
  readonly now?: () => number;
}

export class FuelConnector implements WalletConnector {
  private readonly signer: RealFuelSigner;
  private readonly store: InstrumentStore;
  private readonly network: FuelNetwork;
  private readonly now: () => number;

  constructor(cfg: FuelConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Fuel (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 2_000, // FuelVM fast finality (~1-2s)
      features: {
        nonEvm: true,
        fuelVm: true,
        secp256k1: true,
        addressFormat: "b256",
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
    const id = `payment-instrument-fuel-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        addressFormat: "b256",
        publicKey: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const units = await this.signer.getBalance(FUEL_BASE_ASSET_ID);
    return {
      instrumentId: inst.id,
      asset: ETH_ASSET,
      money: {
        amountAtomic: units.toString(),
        decimals: FUEL_ETH_DECIMALS,
        currency: "ETH",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Fuel is single-step: signAuthorization() builds + signs the transfer intent
   * (no broadcast unless a `submit` hook is wired); settle() adapts the signed
   * result into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `FuelConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const assetId = assetIdForSymbol(input.request.asset.symbol);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amount: input.request.amount.amountAtomic,
      assetId,
      reference: input.request.nonce,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signature, // compact secp256k1 — verifiable offline
      extra: {
        txid: result.txid,
        explorerUrl: result.explorerUrl,
        assetId,
        network: this.network,
        publicKey: this.signer.publicKeyHex,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    // signAuthorization already built + (optionally) broadcast the tx.
    if (!signed.signature) {
      return {
        success: false,
        network: `fuel-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing transaction signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const txid =
      typeof e["txid"] === "string" ? (e["txid"] as string) : undefined;
    return {
      success: true,
      ...(txid !== undefined ? { transactionRef: txid as TransactionRef } : {}),
      network: `fuel-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        txid: e["txid"],
        explorerUrl: e["explorerUrl"],
        assetId: e["assetId"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Recompute the canonical descriptor for a request — used by audits/tests. */
  descriptorFor(input: {
    recipient: string;
    amount: string;
    assetSymbol?: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.recipient,
      amount: input.amount,
      assetId: assetIdForSymbol(input.assetSymbol ?? "ETH"),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
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
