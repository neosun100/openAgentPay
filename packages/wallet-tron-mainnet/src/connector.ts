/**
 * TRON MAINNET Wallet Connector
 * =============================
 *
 * A WalletConnector for the TRON MAINNET chain (TRC-20 USDT + native TRX).
 * Mirrors the testnet TronConnector but defaults to mainnet wiring:
 *
 *   - Crypto:    secp256k1 ECDSA (same curve as Ethereum, different address fmt)
 *   - Address:   base58check(0x41 || keccak256(pubkey[1:])[-20:]) → "T..." 34 chars
 *   - Asset:     TRX (6 dp) + USDT-TRC20 (6 dp)
 *   - Settlement: TriggerSmartContract (TRC-20 transfer), broadcast deferred
 *   - Network:   mainnet (USDT-TRC20 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t)
 *
 * Real signing is done by `RealTronMainnetSigner` (this package). On-chain
 * broadcast stays behind the signer's pluggable `submit` hook so the whole flow
 * runs offline by default — important on mainnet, where broadcast moves value.
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

import { RealTronMainnetSigner } from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "tron-usdt-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "tron-mainnet" as WalletProviderId;

/** USDT-TRC20 contract (mainnet) — the canonical Tether deployment on TRON. */
export const USDT_TRC20_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDT", decimals: 6 },
  { symbol: "TRX", decimals: 6 },
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

export interface TronMainnetConnectorConfig {
  readonly signer: RealTronMainnetSigner;
  readonly instrumentStore: InstrumentStore;
  /** USDT-TRC20 contract address to settle against (defaults to mainnet USDT). */
  readonly usdtContract?: string;
  readonly now?: () => number;
}

export class TronMainnetConnector implements WalletConnector {
  private readonly signer: RealTronMainnetSigner;
  private readonly store: InstrumentStore;
  private readonly usdtContract: string;
  private readonly now: () => number;

  constructor(cfg: TronMainnetConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.usdtContract = cfg.usdtContract ?? USDT_TRC20_MAINNET;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "TRON (mainnet)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer
      settlesOnChain: true,
      typicalLatencyMs: 3000, // ~3s block finality on TRON
      features: {
        nonEvm: true,
        secp256k1: true,
        base58check: true,
        trc20: true,
        network: "mainnet",
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    const existing = await this.store.get(input.userId);
    if (existing) return existing;
    const id = `payment-instrument-tron-mainnet-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: "mainnet",
        usdtContract: this.usdtContract,
        addressHex: this.signer.addressHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.usdtContract);
    return {
      instrumentId: inst.id,
      asset: { symbol: "USDT", decimals: 6, contract: this.usdtContract },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDT",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `TronMainnetConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const contract =
      input.request.asset.contract ??
      (input.request.asset.symbol === "TRX" ? undefined : this.usdtContract);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(contract !== undefined ? { contract } : {}),
      reference: input.request.nonce,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signature,
      extra: {
        txId: result.txId,
        explorerUrl: result.explorerUrl,
        network: "mainnet",
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: "tron-mainnet",
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing tx signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const txRef = (typeof e["txId"] === "string" ? e["txId"] : signed.signature) as TransactionRef;
    return {
      success: true,
      transactionRef: txRef,
      network: "tron-mainnet",
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        txId: e["txId"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

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
