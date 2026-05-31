/**
 * Kaspa Wallet Connector
 * ======================
 *
 * Non-EVM connector proving the WalletConnector abstraction holds for the
 * Kaspa BlockDAG (GHOSTDAG/kHeavyHash) chain model:
 *
 *   - Crypto: secp256k1 ECDSA for the OAP identity + authorization layer.
 *     (Real Kaspa on-chain txs use Schnorr/BIP340 over the SAME secp256k1
 *     private key; the production `submit` hook re-signs the sighash with
 *     Schnorr — see real-signer.ts for the documented rationale.)
 *   - Identity: 24-word BIP39 mnemonic → BIP44 m/44'/111111'/0'/0/0.
 *   - Address: Kaspa cashaddr "kaspatest:…" (base32 over version||x-pubkey).
 *   - Settlement: kaspad submitTransaction (vs EVM contract call / Cosmos MsgSend).
 *   - Asset: KAS (sompi, 8 dp) — 1 KAS = 100,000,000 sompi.
 *
 * Still satisfies the identical 5-method WalletConnector contract.
 *
 * Implementation: pure TypeScript signing through `RealKaspaSigner`. On-chain
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
  SettlementResult,
  SignAuthorizationInput,
  SignedAuthorization,
  TransactionRef,
  UserId,
  WalletCapabilities,
  WalletConnector,
  WalletProviderId,
  ProtocolId,
} from "@openagentpay/core";

import {
  RealKaspaSigner,
  canonicalTransferDescriptor,
  KASPA_HRP,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "kaspa-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "kaspa" as WalletProviderId;

/** KAS decimals — 1 KAS = 100,000,000 sompi. */
export const KAS_DECIMALS = 8;
/** Native KAS denom (smallest unit). */
export const SOMPI_DENOM = "sompi";

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "KAS", decimals: KAS_DECIMALS }];

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

export interface KaspaConnectorConfig {
  readonly signer: RealKaspaSigner;
  readonly instrumentStore: InstrumentStore;
  /** Network label for capabilities / settlement (default from signer). */
  readonly network?: string;
  readonly now?: () => number;
}

export class KaspaConnector implements WalletConnector {
  private readonly signer: RealKaspaSigner;
  private readonly store: InstrumentStore;
  private readonly network: string;
  private readonly now: () => number;

  constructor(cfg: KaspaConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? cfg.signer.network;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Kaspa (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side mnemonic signer
      settlesOnChain: true,
      typicalLatencyMs: 1000, // Kaspa targets ~1 block/s (10 bps on testnet-10)
      features: {
        nonEvm: true,
        secp256k1: true,
        blockDag: true,
        cashaddrHrp: this.signer.hrp,
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
    const id = `payment-instrument-kaspa-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        cashaddrHrp: this.signer.hrp,
        pubkeyHex: this.signer.publicKeyHex,
        denom: SOMPI_DENOM,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance();
    return {
      instrumentId: inst.id,
      asset: { symbol: "KAS", decimals: KAS_DECIMALS },
      money: {
        amountAtomic: atomic.toString(),
        decimals: KAS_DECIMALS,
        currency: "KAS",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Kaspa transfers are single-shot (build → sign → broadcast). We split the
   * flow to fit the 5-method contract: signAuthorization() produces the real
   * secp256k1 authorization (and broadcasts if a `submit` hook is wired);
   * settle() returns the result.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `KaspaConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
      amountAtomic: input.request.amount.amountAtomic,
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
        denom: SOMPI_DENOM,
        network: this.network,
        ...(result.txId !== undefined ? { txId: result.txId } : {}),
        ...(result.daaScore !== undefined ? { daaScore: result.daaScore } : {}),
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
        network: `kaspa-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing transfer signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    // On-chain tx id if broadcast happened; else fall back to the signature
    // as the local authorization reference (offline-safe).
    const txRef = (typeof e["txId"] === "string" && e["txId"]
      ? (e["txId"] as string)
      : signed.signature) as TransactionRef;
    return {
      success: true,
      transactionRef: txRef,
      network: `kaspa-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        denom: e["denom"],
        daaScore: e["daaScore"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Re-derive the canonical descriptor for a signed request (for audit/verify). */
  descriptorFor(signed: SignedAuthorization): string {
    return canonicalTransferDescriptor({
      from: signed.signer,
      to: signed.request.recipient,
      amountAtomic: signed.request.amount.amountAtomic,
      network: this.network,
      ...(signed.request.description !== undefined
        ? { memo: signed.request.description }
        : {}),
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

// Re-export the hrp constant so consumers don't need the signer module.
export { KASPA_HRP };
