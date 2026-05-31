/**
 * BitgetPayConnector
 * ==================
 *
 * Implements {@link WalletConnector} for Bitget Wallet Pay merchants.
 *
 * Maps to the 5-method WalletConnector contract:
 *   1. getCapabilities()  — pure self-report
 *   2. createInstrument() — bind a user to this merchant account (idempotent)
 *   3. getBalance()       — read the merchant balance (offline mock by default)
 *   4. signAuthorization()— produce an OAP-CEX wire token (HMAC-SHA256)
 *   5. settle()           — broadcast via the signer's pluggable submit hook
 *
 * The cryptography (HMAC-SHA256 sign + verify) lives in {@link RealBitgetSigner}
 * so the connector stays a thin orchestration shim.
 *
 * @license Apache-2.0
 */

import { createHmac } from "node:crypto";
import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type ProtocolId,
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
  type OapCexWireToken,
  encodeWireToken,
  PROTOCOL_ID as OAP_CEX_PROTOCOL_ID,
} from "@openagentpay/protocol-cex-pay";

import {
  type BitgetAuthPayload,
  BITGET_SIG_ALG,
  RealBitgetSigner,
} from "./real-signer.js";

// ============================================================================
//  Configuration
// ============================================================================

export const WALLET_PROVIDER_ID = "bitget" as WalletProviderId;

/** The OAP-CEX protocol this connector signs for. */
export const PROTOCOL_ID: ProtocolId = OAP_CEX_PROTOCOL_ID;

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDT", decimals: 6 },
  { symbol: "USDC", decimals: 6 },
];

export interface BitgetPayConnectorConfig {
  /** The HMAC signer (holds the mock apiKey/apiSecret credential). */
  readonly signer: RealBitgetSigner;
  /** Storage adapter for (userId → Instrument) bindings. */
  readonly instrumentStore: InstrumentStore;
  /** Optional clock — overridable for deterministic tests. */
  readonly now?: () => number;
}

// ============================================================================
//  InstrumentStore
// ============================================================================

export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(instrumentId: InstrumentId): Promise<Instrument | undefined>;
}

/** Pure in-memory store. For tests and local dev. */
export class MemoryInstrumentStore implements InstrumentStore {
  private readonly byUser = new Map<string, Instrument>();
  private readonly byId = new Map<string, Instrument>();
  async get(userId: UserId): Promise<Instrument | undefined> {
    return this.byUser.get(userId);
  }
  async put(instrument: Instrument): Promise<void> {
    this.byUser.set(instrument.userId, instrument);
    this.byId.set(instrument.id, instrument);
  }
  async getById(id: InstrumentId): Promise<Instrument | undefined> {
    return this.byId.get(id);
  }
}

// ============================================================================
//  Connector
// ============================================================================

export class BitgetPayConnector implements WalletConnector {
  private readonly signer: RealBitgetSigner;
  private readonly store: InstrumentStore;
  private readonly now: () => number;

  constructor(config: BitgetPayConnectorConfig) {
    this.signer = config.signer;
    this.store = config.instrumentStore;
    this.now = config.now ?? Date.now;
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Bitget Wallet Pay",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // API-key based, fully autonomous
      settlesOnChain: false, // CEX-internal settlement
      typicalLatencyMs: 700,
      features: {
        gasFree: true,
        instantSettlement: true,
        sandboxAvailable: true,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("userId is required");
    }
    // Idempotent: same userId → same instrument.
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const instrument: Instrument = {
      id: this.makeInstrumentId(input.userId),
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.merchantId,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        merchantId: this.signer.merchantId,
        ...(input.metadata !== undefined ? input.metadata : {}),
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const decimals = 6;
    // Offline-safe deterministic balance (no network round-trip in tests).
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDT", decimals },
      money: {
        amountAtomic: "0",
        decimals,
        currency: "USDT",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    const instrument = await this.requireInstrument(input.instrumentId);
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `BitgetPayConnector only supports protocol ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }

    const signedAt = Math.floor(this.now() / 1000);
    const authPayload: BitgetAuthPayload = {
      asset: input.request.asset.symbol,
      amount: input.request.amount.amountAtomic,
      amountDecimals: input.request.amount.decimals,
      from: instrument.publicHandle,
      to: input.request.recipient,
      nonce: input.request.nonce,
      validBefore: input.request.validBefore,
      signedAt,
    };

    const signatureValue = this.signer.sign(authPayload);

    const wireToken: OapCexWireToken = {
      oapCexVersion: 1,
      scheme: "cex-pay",
      provider: "bitget",
      authorization: authPayload,
      signature: { alg: BITGET_SIG_ALG, value: signatureValue },
    };

    return {
      request: input.request,
      signer: instrument.publicHandle,
      signature: signatureValue,
      encoded: encodeWireToken(wireToken),
      extra: { wireToken, authPayload },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const payload = (signed.extra?.["authPayload"] ?? null) as BitgetAuthPayload | null;
    if (!payload) {
      return {
        success: false,
        network: this.signer.network,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "missing authPayload in signed.extra",
      };
    }

    // Re-verify the HMAC before broadcasting — defence in depth.
    if (!this.signer.verify(payload, signed.signature)) {
      return {
        success: false,
        network: this.signer.network,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "HMAC verification failed at settle()",
      };
    }

    try {
      const result = await this.signer.settle(payload, signed.signature);
      return {
        success: true,
        transactionRef: result.transactionRef as TransactionRef,
        network: result.network ?? this.signer.network,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: result.raw,
      };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return {
        success: false,
        network: this.signer.network,
        settledAt: nowIso(this.now()),
        errorCode: "rpc_error",
        errorMessage: e.message ?? "bitget-pay settlement error",
      };
    }
  }

  // ---- internals -----------------------------------------------------------

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) {
      throw new Error(`Instrument not found: ${id}`);
    }
    return i;
  }

  private makeInstrumentId(userId: UserId): InstrumentId {
    const hash = createHmac("sha256", this.signer.merchantId)
      .update(userId)
      .digest("hex")
      .slice(0, 16);
    return `payment-instrument-bitget-${hash}` as InstrumentId;
  }
}

// ============================================================================
//  helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}
