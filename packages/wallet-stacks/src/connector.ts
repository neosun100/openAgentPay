/**
 * Stacks Wallet Connector
 * =======================
 *
 * A WalletConnector for Stacks (Bitcoin L2, testnet by default), backed by a
 * real secp256k1 signer with native c32check address derivation. Broadcast
 * stays behind the signer's pluggable `submit` hook so signing runs fully
 * offline.
 *
 * Proves the WalletConnector abstraction holds for a Bitcoin-secured L2:
 *   - Account model: account-nonce (Stacks) — like EVM, unlike Bitcoin's UTXO
 *   - Crypto: secp256k1 ECDSA (same curve as Bitcoin/Ethereum)
 *   - Address: c32check "ST…" (Stacks Crockford-base32 + dSHA256 checksum) —
 *     neither bech32 (Bitcoin) nor base58check (Tron) nor base58 (Solana)
 *   - Asset: STX, 6 decimals, smallest unit = microSTX (µSTX)
 *
 * Single-step settlement model (like Solana/Bitcoin): signAuthorization()
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
  RealStacksSigner,
  canonicalTransferDescriptor,
  type StacksNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "stacks-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "stacks" as WalletProviderId;
export const X_PAYMENT_STACKS_HEADER = "X-PAYMENT-STACKS";

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "STX", decimals: 6 }];

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

export interface StacksConnectorConfig {
  readonly signer: RealStacksSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network — defaults to "testnet". */
  readonly network?: StacksNetwork;
  readonly now?: () => number;
}

export class StacksConnector implements WalletConnector {
  private readonly signer: RealStacksSigner;
  private readonly store: InstrumentStore;
  private readonly network: StacksNetwork;
  private readonly now: () => number;

  constructor(cfg: StacksConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Stacks (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 600_000, // anchored to Bitcoin block cadence (~10 min)
      features: {
        nonEvm: true,
        bitcoinL2: true,
        secp256k1: true,
        addressFormat: "c32check",
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
    const id = `payment-instrument-stacks-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        addressFormat: "c32check",
        publicKey: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const microStx = await this.signer.getBalance();
    return {
      instrumentId: inst.id,
      asset: { symbol: "STX", decimals: 6 },
      money: {
        amountAtomic: microStx.toString(),
        decimals: 6,
        currency: "STX",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Stacks is single-step: signAuthorization() builds + signs the STX
   * token-transfer intent (no broadcast unless a `submit` hook is wired);
   * settle() adapts the signed result into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `StacksConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
      amountMicroStx: input.request.amount.amountAtomic,
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
        network: `stacks-${this.network}`,
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
      network: `stacks-${this.network}`,
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
    amountMicroStx: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.recipient,
      amountMicroStx: input.amountMicroStx,
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
