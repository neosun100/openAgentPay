/**
 * Dogecoin Wallet Connector
 * =========================
 *
 * A WalletConnector for Dogecoin (legacy P2PKH testnet), backed by a real
 * secp256k1 signer with base58check address derivation. Broadcast stays behind
 * the signer's pluggable `submit` hook so signing runs fully offline.
 *
 * Proves the WalletConnector abstraction holds for the legacy-UTXO model:
 *   - Account model: UTXO (Doge/Bitcoin) vs account-nonce (EVM/Tron) vs stateless (Solana)
 *   - Crypto: secp256k1 ECDSA, DER-encoded, low-S normalized (BIP-62/146)
 *   - Address: base58check P2PKH "D…"/"n…" (no SegWit — Doge never adopted it)
 *   - Asset: DOGE, 8 decimals, smallest unit = koinu
 *
 * Single-step settlement model (like Bitcoin/Solana): signAuthorization()
 * builds + signs the transfer intent; settle() adapts that into a
 * SettlementResult.
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
  RealDogecoinSigner,
  canonicalTransferDescriptor,
  type DogecoinNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "dogecoin-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "dogecoin" as WalletProviderId;
export const X_PAYMENT_DOGECOIN_HEADER = "X-PAYMENT-DOGECOIN";

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "DOGE", decimals: 8 }];

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

export interface DogecoinConnectorConfig {
  readonly signer: RealDogecoinSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network — defaults to "testnet". */
  readonly network?: DogecoinNetwork;
  readonly now?: () => number;
}

export class DogecoinConnector implements WalletConnector {
  private readonly signer: RealDogecoinSigner;
  private readonly store: InstrumentStore;
  private readonly network: DogecoinNetwork;
  private readonly now: () => number;

  constructor(cfg: DogecoinConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Dogecoin (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 60_000, // ~1 min Doge block time
      features: {
        nonEvm: true,
        utxo: true,
        secp256k1: true,
        segwit: false, // Dogecoin never adopted SegWit
        addressFormat: "base58check-p2pkh",
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
    const id = `payment-instrument-dogecoin-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        addressFormat: "base58check-p2pkh",
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const koinu = await this.signer.getBalance();
    return {
      instrumentId: inst.id,
      asset: { symbol: "DOGE", decimals: 8 },
      money: {
        amountAtomic: koinu.toString(),
        decimals: 8,
        currency: "DOGE",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Dogecoin is single-step: there is no separate on-chain "authorize" then
   * "transfer" — the wallet builds a raw legacy tx and signs it in one shot.
   * We split the flow to fit the 5-method interface: signAuthorization()
   * builds + signs the transfer intent (no broadcast unless a `submit` hook is
   * wired); settle() adapts the signed result into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `DogecoinConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
      amountKoinu: input.request.amount.amountAtomic,
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
        network: `dogecoin-${this.network}`,
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
      network: `dogecoin-${this.network}`,
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
    amountKoinu: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.recipient,
      amountKoinu: input.amountKoinu,
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
