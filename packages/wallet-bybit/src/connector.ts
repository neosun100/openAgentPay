/**
 * BybitPayConnector
 * =================
 *
 * Implements {@link WalletConnector} for Bybit Pay (CEX, off-chain settlement).
 *
 * Mirrors the proven wallet-binance template, but:
 *   - Signs with HMAC-SHA256 (Bybit V5 spec) instead of SHA512.
 *   - Uses a {@link RealBybitSigner} as the crypto primitive so signatures are
 *     real & independently verifiable (see signer.verify / connector.verify).
 *   - Keeps on-chain/CEX broadcast behind an OPTIONAL pluggable `submit` hook.
 *     Default is offline-safe: a deterministic mock Bybit transactionId, so
 *     conformance + unit tests run with zero network.
 *   - FIXES a contract bug present in the binance template: createInstrument
 *     now rejects an empty userId (conformance test "rejected on missing
 *     userId" requires a throw).
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
  RealBybitSigner,
  generateBybitKeypair,
  type BybitCredential,
  type BybitSignParams,
} from "./real-signer.js";

// ============================================================================
//  Configuration
// ============================================================================

export const WALLET_PROVIDER_ID = "bybit" as WalletProviderId;

/** Stable OAP-CEX protocol id this connector satisfies ("cex-pay-v0.1"). */
export const PROTOCOL_ID: ProtocolId = OAP_CEX_PROTOCOL_ID;

/**
 * Result of an offline/real broadcast attempt. The connector maps this into a
 * {@link SettlementResult}.
 */
export interface BybitSubmitResult {
  readonly transactionId: string;
  readonly raw?: unknown;
}

/**
 * Optional broadcast hook. When omitted, the connector settles offline with a
 * deterministic mock Bybit transactionId (safe for CI / conformance). Provide
 * a real implementation to call Bybit's `/v5/...` transfer endpoint.
 */
export type BybitSubmitHook = (
  signed: SignedAuthorization,
  wireToken: OapCexWireToken
) => Promise<BybitSubmitResult>;

export interface BybitPayConnectorConfig {
  /**
   * Bound credential pair. Omit to auto-generate a fresh mock credential
   * IN-PROCESS (no signups, no network) via {@link generateBybitKeypair}.
   */
  readonly credential?: BybitCredential;
  /** Storage adapter for (userId → Instrument) bindings. */
  readonly instrumentStore: InstrumentStore;
  /** Optional broadcast hook — defaults to offline-safe deterministic mock. */
  readonly submit?: BybitSubmitHook;
  /** Receive-window in ms for the Bybit signature preimage (default "5000"). */
  readonly recvWindow?: string;
  /** Overridable clock for deterministic tests. */
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
//  Supported assets
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDT", decimals: 6 },
  { symbol: "USDC", decimals: 6 },
];

// ============================================================================
//  Connector
// ============================================================================

export class BybitPayConnector implements WalletConnector {
  private readonly signer: RealBybitSigner;
  private readonly store: InstrumentStore;
  private readonly submitHook: BybitSubmitHook;
  private readonly recvWindow: string;
  private readonly now: () => number;

  constructor(config: BybitPayConnectorConfig) {
    const credential = config.credential ?? generateBybitKeypair();
    this.signer = new RealBybitSigner({ credential });
    this.store = config.instrumentStore;
    this.recvWindow = config.recvWindow ?? "5000";
    this.now = config.now ?? Date.now;
    this.submitHook = config.submit ?? defaultOfflineSubmit;
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Bybit Pay",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // API-key based, fully autonomous
      settlesOnChain: false, // CEX-internal, off-chain settlement
      typicalLatencyMs: 700,
      features: {
        gasFree: true,
        instantSettlement: true,
        sandboxAvailable: true,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    // CONTRACT FIX (vs binance template): reject empty userId.
    if (!input.userId) {
      throw new Error("userId is required");
    }

    // Idempotent: same userId → same instrument.
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const id = this.makeInstrumentId(input.userId);
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.accountId, // mock Bybit account id
      createdAt: nowIso(this.now()),
      providerMetadata: {
        accountId: this.signer.accountId,
        apiKey: this.signer.apiKey,
        ...(input.metadata ?? {}),
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    // Offline-safe deterministic balance (mirrors a Bybit funding-wallet query).
    const decimals = 6;
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDT", decimals },
      money: {
        amountAtomic: "25000000", // 25.000000 USDT
        decimals,
        currency: "USDT",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an OAP-CEX authorization. Produces the wire token that goes in the
   * X-PAYMENT-CEX header. The actual Bybit broadcast happens in {@link settle}.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    const instrument = await this.requireInstrument(input.instrumentId);
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `BybitPayConnector only supports protocol ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }

    const signedAt = Math.floor(this.now() / 1000);

    const authorization: OapCexWireToken["authorization"] = {
      asset: input.request.asset.symbol,
      amount: input.request.amount.amountAtomic,
      amountDecimals: input.request.amount.decimals,
      from: instrument.publicHandle,
      to: input.request.recipient,
      nonce: input.request.nonce,
      validBefore: input.request.validBefore,
      signedAt,
    };

    // Build the Bybit V5 canonical preimage over the authorization payload.
    const params = this.buildSignParams(authorization);
    const signatureValue = this.signer.sign(params);

    const wireToken: OapCexWireToken = {
      oapCexVersion: 1,
      scheme: "cex-pay",
      provider: "bybit",
      authorization,
      signature: { alg: "HMAC-SHA256", value: signatureValue },
      providerExtensions: {
        timestamp: params.timestamp,
        recvWindow: params.recvWindow,
        apiKey: this.signer.apiKey,
      },
    };

    return {
      request: input.request,
      signer: instrument.publicHandle,
      signature: signatureValue,
      encoded: encodeWireToken(wireToken),
      extra: { wireToken, signParams: params },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireToken = (signed.extra?.["wireToken"] ?? null) as OapCexWireToken | null;
    if (!wireToken) {
      return failure("missing wire token in signed.extra", "signature_invalid");
    }

    try {
      const res = await this.submitHook(signed, wireToken);
      return {
        success: true,
        transactionRef: res.transactionId as TransactionRef,
        network: "bybit-pay-testnet",
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        ...(res.raw !== undefined ? { raw: res.raw } : {}),
      };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; raw?: unknown };
      return {
        success: false,
        network: "bybit-pay-testnet",
        settledAt: nowIso(this.now()),
        errorCode: mapBybitErrorToCode(e.code),
        errorMessage: e.message ?? "bybit-pay settlement error",
        ...(e.raw !== undefined ? { raw: e.raw } : {}),
      };
    }
  }

  // ---- verification helper (independent of settle) ------------------------

  /**
   * Verify a previously produced SignedAuthorization's HMAC-SHA256 signature.
   * Returns false if the wire token / sign params are missing or tampered.
   */
  verify(signed: SignedAuthorization): boolean {
    const params = signed.extra?.["signParams"] as BybitSignParams | undefined;
    if (!params) return false;
    return this.signer.verify(params, signed.signature);
  }

  // ---- internals -----------------------------------------------------------

  private buildSignParams(
    authorization: OapCexWireToken["authorization"]
  ): BybitSignParams {
    return {
      timestamp: String(this.now()),
      apiKey: this.signer.apiKey,
      recvWindow: this.recvWindow,
      payload: canonicalJson(authorization),
    };
  }

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) {
      throw new Error(`Instrument not found: ${id}`);
    }
    return i;
  }

  private makeInstrumentId(userId: UserId): InstrumentId {
    const hash = createHmac("sha256", this.signer.apiKey)
      .update(userId)
      .digest("hex")
      .slice(0, 16);
    return `payment-instrument-bybit-${hash}` as InstrumentId;
  }
}

// ============================================================================
//  Default offline-safe submit hook
// ============================================================================

/**
 * Deterministic mock broadcast. Produces a Bybit-style transactionId derived
 * from the wire token nonce + signedAt, so the same authorization always maps
 * to the same ref (replay-detectable, reproducible). NO network.
 */
const defaultOfflineSubmit: BybitSubmitHook = async (_signed, wireToken) => {
  const seed = `${wireToken.authorization.nonce}:${wireToken.authorization.signedAt}`;
  const digest = createHmac("sha256", "bybit-offline-tx-v1")
    .update(seed)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return { transactionId: `BYBIT_${digest}`, raw: { offline: true } };
};

// ============================================================================
//  helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}

/** Stable key ordering for the signature preimage. */
function canonicalJson(authorization: OapCexWireToken["authorization"]): string {
  return JSON.stringify({
    amount: authorization.amount,
    amountDecimals: authorization.amountDecimals,
    asset: authorization.asset,
    from: authorization.from,
    nonce: authorization.nonce,
    signedAt: authorization.signedAt,
    to: authorization.to,
    validBefore: authorization.validBefore,
  });
}

function failure(
  msg: string,
  errorCode: NonNullable<SettlementResult["errorCode"]>
): SettlementResult {
  return {
    success: false,
    network: "bybit-pay-testnet",
    settledAt: new Date().toISOString(),
    errorMessage: msg,
    errorCode,
  };
}

function mapBybitErrorToCode(
  code?: string
): NonNullable<SettlementResult["errorCode"]> {
  switch (code) {
    case "auth":
      return "signature_invalid";
    case "rate_limited":
      return "rate_limited";
    case "validation":
      return "expired_authorization";
    case "insufficient":
      return "insufficient_funds";
    case "network":
    case "timeout":
      return "rpc_error";
    default:
      return "unknown";
  }
}

// expose for unit testing
export const __internal = { canonicalJson, defaultOfflineSubmit, mapBybitErrorToCode };
