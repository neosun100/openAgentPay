/**
 * Litecoin Wallet Connector
 * =========================
 *
 * A WalletConnector for Litecoin (native SegWit P2WPKH, testnet by default),
 * backed by a real secp256k1 signer with bech32 address derivation. Broadcast
 * stays behind the signer's pluggable `submit` hook so signing runs fully
 * offline.
 *
 * Litecoin is a direct Bitcoin fork — same UTXO model, same secp256k1 curve,
 * same hash160 witness program. The wallet-layer difference is purely the
 * bech32 hrp ("tltc" testnet / "ltc" mainnet → "tltc1q…"). This proves the
 * WalletConnector abstraction generalizes cleanly across Bitcoin-family chains.
 *
 * Single-step settlement model (like Solana/Bitcoin): signAuthorization()
 * builds + signs the transfer intent; settle() adapts that into a
 * SettlementResult.
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
} from "@openagentpay/core";

import {
  RealLitecoinSigner,
  canonicalTransferDescriptor,
  type LitecoinNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "litecoin-pay-v1" as ProtocolIdLike;
export const WALLET_PROVIDER_ID = "litecoin" as WalletProviderId;
export const X_PAYMENT_LITECOIN_HEADER = "X-PAYMENT-LITECOIN";

// Local alias to keep the import list tidy while preserving the branded type.
type ProtocolIdLike = import("@openagentpay/core").ProtocolId;

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "LTC", decimals: 8 }];

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

export interface LitecoinConnectorConfig {
  readonly signer: RealLitecoinSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network — defaults to "testnet". */
  readonly network?: LitecoinNetwork;
  readonly now?: () => number;
}

export class LitecoinConnector implements WalletConnector {
  private readonly signer: RealLitecoinSigner;
  private readonly store: InstrumentStore;
  private readonly network: LitecoinNetwork;
  private readonly now: () => number;

  constructor(cfg: LitecoinConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Litecoin (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; hardware-wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 150_000, // ~2.5 min block time (4x faster than Bitcoin)
      features: {
        nonEvm: true,
        utxo: true,
        secp256k1: true,
        segwit: true,
        addressFormat: "bech32-p2wpkh",
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
    const id = `payment-instrument-litecoin-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        addressFormat: "bech32-p2wpkh",
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const litoshis = await this.signer.getBalance();
    return {
      instrumentId: inst.id,
      asset: { symbol: "LTC", decimals: 8 },
      money: {
        amountAtomic: litoshis.toString(),
        decimals: 8,
        currency: "LTC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Litecoin is single-step: there is no separate on-chain "authorize" then
   * "transfer" — the wallet builds a PSBT and signs it in one shot. We split
   * the flow to fit the 5-method interface: signAuthorization() builds + signs
   * the transfer intent (no broadcast unless a `submit` hook is wired);
   * settle() adapts the signed result into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `LitecoinConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountLitoshis: input.request.amount.amountAtomic,
      reference: input.request.nonce,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signature, // DER-encoded ECDSA — verifiable offline
      extra: {
        txid: result.txid,
        explorerUrl: result.explorerUrl,
        network: this.network,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    // signAuthorization already built + (optionally) broadcast the tx.
    // Adapt the result into a SettlementResult.
    if (!signed.signature) {
      return {
        success: false,
        network: `litecoin-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing transaction signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const txid = typeof e["txid"] === "string" ? (e["txid"] as string) : undefined;
    return {
      success: true,
      ...(txid !== undefined ? { transactionRef: txid as TransactionRef } : {}),
      network: `litecoin-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        txid: e["txid"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Recompute the canonical descriptor for a request — used by audits/tests. */
  descriptorFor(input: {
    recipient: string;
    amountLitoshis: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.recipient,
      amountLitoshis: input.amountLitoshis,
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
