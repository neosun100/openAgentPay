/**
 * Bitcoin Wallet Connector
 * ========================
 *
 * A WalletConnector for Bitcoin (native SegWit testnet P2WPKH), backed by a
 * real secp256k1 signer with bech32 address derivation. Broadcast stays behind
 * the signer's pluggable `submit` hook so signing runs fully offline.
 *
 * Proves the WalletConnector abstraction holds for the UTXO model:
 *   - Account model: UTXO (Bitcoin) vs account-nonce (EVM/Tron) vs stateless (Solana)
 *   - Crypto: secp256k1 ECDSA, DER-encoded, low-S normalized (BIP-62/146)
 *   - Address: bech32 witness-v0 "tb1q…" (BIP-173) vs base58check (Tron) vs base58 (Solana)
 *   - Asset: BTC, 8 decimals, smallest unit = satoshi
 *
 * Single-step settlement model (like Solana): signAuthorization() builds +
 * signs the transfer intent; settle() adapts that into a SettlementResult.
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
  RealBitcoinSigner,
  canonicalTransferDescriptor,
  type BitcoinNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "bitcoin-pay-v1" as ProtocolIdLike;
export const WALLET_PROVIDER_ID = "bitcoin" as WalletProviderId;
export const X_PAYMENT_BITCOIN_HEADER = "X-PAYMENT-BITCOIN";

// Local alias to keep the import list tidy while preserving the branded type.
type ProtocolIdLike = import("@openagentpay/core").ProtocolId;

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "BTC", decimals: 8 }];

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

export interface BitcoinConnectorConfig {
  readonly signer: RealBitcoinSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network — defaults to "testnet". */
  readonly network?: BitcoinNetwork;
  readonly now?: () => number;
}

export class BitcoinConnector implements WalletConnector {
  private readonly signer: RealBitcoinSigner;
  private readonly store: InstrumentStore;
  private readonly network: BitcoinNetwork;
  private readonly now: () => number;

  constructor(cfg: BitcoinConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Bitcoin (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; hardware-wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 600_000, // ~10 min block time
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
    const id = `payment-instrument-bitcoin-${input.userId}` as InstrumentId;
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
    const sats = await this.signer.getBalance();
    return {
      instrumentId: inst.id,
      asset: { symbol: "BTC", decimals: 8 },
      money: {
        amountAtomic: sats.toString(),
        decimals: 8,
        currency: "BTC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Bitcoin is single-step: there is no separate on-chain "authorize" then
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
        `BitcoinConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
      amountSats: input.request.amount.amountAtomic,
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
        network: `bitcoin-${this.network}`,
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
      network: `bitcoin-${this.network}`,
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
    amountSats: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.recipient,
      amountSats: input.amountSats,
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
