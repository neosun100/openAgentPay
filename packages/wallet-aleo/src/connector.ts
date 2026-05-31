/**
 * Aleo Wallet Connector
 * =====================
 *
 * A WalletConnector for Aleo (privacy-focused L1, testnet by default), backed
 * by a real ed25519 signer with a bech32m "aleo1…" address codec. Broadcast
 * (zk proof generation + node submission) stays behind the signer's pluggable
 * `submit` hook so signing runs fully offline.
 *
 * Proves the WalletConnector abstraction holds for a zk L1:
 *   - Account model: account-key → address (zkSNARK), approximated here with
 *     an ed25519 identity (production swaps the signer for Aleo Schnorr).
 *   - Address: bech32m "aleo1…" — like Bitcoin bech32 in *form* but with HRP
 *     "aleo" and Aleo's fixed-HRP convention (no network byte).
 *   - Asset: ALEO credits (6 decimals, smallest unit = microcredits) + a
 *     USDC placeholder for the testnet asset menu.
 *
 * Single-step settlement model (like Solana/Stacks): signAuthorization()
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
  RealAleoSigner,
  canonicalTransferDescriptor,
  type AleoNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "aleo-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "aleo" as WalletProviderId;
export const X_PAYMENT_ALEO_HEADER = "X-PAYMENT-ALEO";

/** Native ALEO credits (6 decimals → microcredits) + a USDC placeholder. */
const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "ALEO", decimals: 6 },
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

export interface AleoConnectorConfig {
  readonly signer: RealAleoSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network — defaults to "testnet". */
  readonly network?: AleoNetwork;
  readonly now?: () => number;
}

export class AleoConnector implements WalletConnector {
  private readonly signer: RealAleoSigner;
  private readonly store: InstrumentStore;
  private readonly network: AleoNetwork;
  private readonly now: () => number;

  constructor(cfg: AleoConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Aleo (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 15_000, // Aleo block cadence (~15s)
      features: {
        nonEvm: true,
        zkL1: true,
        ed25519: true, // testnet-shaped identity (production: Aleo Schnorr)
        addressFormat: "bech32m",
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
    const id = `payment-instrument-aleo-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        addressFormat: "bech32m",
        publicKey: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const microcredits = await this.signer.getBalance();
    return {
      instrumentId: inst.id,
      asset: { symbol: "ALEO", decimals: 6 },
      money: {
        amountAtomic: microcredits.toString(),
        decimals: 6,
        currency: "ALEO",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Aleo is single-step: signAuthorization() builds + signs the credits
   * transfer intent (no broadcast unless a `submit` hook is wired); settle()
   * adapts the signed result into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `AleoConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
      amountMicrocredits: input.request.amount.amountAtomic,
      asset: input.request.asset.symbol,
      reference: input.request.nonce,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signature, // ed25519 — verifiable offline
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
        network: `aleo-${this.network}`,
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
      network: `aleo-${this.network}`,
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
    amountMicrocredits: string;
    asset: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.recipient,
      amountMicrocredits: input.amountMicrocredits,
      asset: input.asset,
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
