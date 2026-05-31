/**
 * Starknet Wallet Connector
 * =========================
 *
 * A WalletConnector for Starknet (STARK-friendly validity-rollup L2, Sepolia by
 * default), backed by a real secp256k1 signer with a deterministic
 * felt252-shaped address. Broadcast stays behind the signer's pluggable
 * `submit` hook so signing runs fully offline.
 *
 * Proves the WalletConnector abstraction holds for a STARK-friendly L2:
 *   - Account model: account-abstraction contracts (Starknet) — every account
 *     is a contract; addresses are felt252 field elements.
 *   - Address: felt252 — `0x` + up to 64 hex, value < the STARK prime field.
 *     Here derived as keccak(secp256k1 pubkey)[:31 bytes] → felt (testnet-shaped,
 *     documented in real-signer.ts).
 *   - Assets: native ETH (18 decimals) + USDC (6 decimals).
 *   - Settlement: single-step (like Solana/Stacks). signAuthorization() builds +
 *     signs the transfer intent; settle() adapts that into a SettlementResult.
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
  RealStarknetSigner,
  canonicalTransferDescriptor,
  type StarknetNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "starknet-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "starknet" as WalletProviderId;
export const X_PAYMENT_STARKNET_HEADER = "X-PAYMENT-STARKNET";

/** Native ETH (18 dp) + USDC (6 dp) — both well under the 24-decimal cap. */
const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "ETH", decimals: 18 },
  { symbol: "USDC", decimals: 6 },
];

function decimalsFor(symbol: string): number {
  const a = SUPPORTED_ASSETS.find((x) => x.symbol === symbol);
  return a ? a.decimals : 18;
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

export interface StarknetConnectorConfig {
  readonly signer: RealStarknetSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network — defaults to "sepolia". */
  readonly network?: StarknetNetwork;
  readonly now?: () => number;
}

export class StarknetConnector implements WalletConnector {
  private readonly signer: RealStarknetSigner;
  private readonly store: InstrumentStore;
  private readonly network: StarknetNetwork;
  private readonly now: () => number;

  constructor(cfg: StarknetConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "sepolia";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Starknet (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 30_000, // STARK proof + L1 confirmation cadence
      features: {
        l2: true,
        starkFriendly: true,
        accountAbstraction: true,
        secp256k1Signer: true, // testnet-shaped identity; see real-signer.ts
        addressFormat: "felt252",
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
    const id = `payment-instrument-starknet-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        addressFormat: "felt252",
        publicKey: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const symbol = "ETH";
    const decimals = decimalsFor(symbol);
    const atomic = await this.signer.getBalance(symbol);
    return {
      instrumentId: inst.id,
      asset: { symbol, decimals },
      money: {
        amountAtomic: atomic.toString(),
        decimals,
        currency: symbol,
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Starknet is single-step: signAuthorization() builds + signs the transfer
   * intent (no broadcast unless a `submit` hook is wired); settle() adapts the
   * signed result into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `StarknetConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const asset = input.request.asset.symbol;
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      asset,
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
        txHash: result.txHash,
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
        network: `starknet-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing transaction signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const txHash =
      typeof e["txHash"] === "string" ? (e["txHash"] as string) : undefined;
    return {
      success: true,
      ...(txHash !== undefined
        ? { transactionRef: txHash as TransactionRef }
        : {}),
      network: `starknet-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        txHash: e["txHash"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Recompute the canonical descriptor for a request — used by audits/tests. */
  descriptorFor(input: {
    recipient: string;
    amountAtomic: string;
    asset: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      from: this.signer.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
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
