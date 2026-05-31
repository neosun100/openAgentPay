/**
 * OkxPayConnector
 * ===============
 *
 * Implements {@link WalletConnector} for OKX Pay sub-accounts (CEX rail).
 * Mirrors the BinancePayConnector shape, but:
 *   - uses a 3-piece OKX-style credential (apiKey / apiSecret / passphrase)
 *   - signs the OAP-CEX authorization with HMAC-SHA256 (OKX OK-ACCESS-SIGN)
 *   - keeps settlement broadcast behind a pluggable `submit` hook that defaults
 *     to a deterministic, offline-safe mock receipt id.
 *
 * Method ↔ contract mapping:
 *   1. getCapabilities()  — pure self-report (USDT/USDC, cex-pay-v0.1)
 *   2. createInstrument() — bind a user to this OKX sub-account (idempotent)
 *   3. getBalance()       — report the sub-account balance
 *   4. signAuthorization()— produce an OAP-CEX wire token (HMAC-SHA256)
 *   5. settle()           — submit via the `submit` hook, return tx ref
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
  type OkxAuthorizationPayload,
  type OkxCredential,
  OKX_SIGN_ALG,
  RealOkxSigner,
} from "./real-signer.js";

// ============================================================================
//  Configuration
// ============================================================================

export const WALLET_PROVIDER_ID = "okx" as WalletProviderId;

/** Stable OAP-CEX protocol id this connector satisfies. */
const PROTOCOL_FOR_OKX: ProtocolId = OAP_CEX_PROTOCOL_ID;

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDT", decimals: 6 },
  { symbol: "USDC", decimals: 6 },
];

/**
 * Optional broadcast hook. In production this calls OKX's REST API to execute
 * the internal transfer. In tests / offline it is omitted and we return a
 * deterministic mock receipt id, so the sign path is still real but no network
 * is touched.
 */
export type OkxSubmitHook = (args: {
  readonly wireToken: OapCexWireToken;
  readonly signed: SignedAuthorization;
}) => Promise<{ transactionRef: string; raw?: unknown }>;

export interface OkxPayConnectorConfig {
  /**
   * Pre-built signer (holds the credential). Either pass this, or pass
   * `credential`, or pass `seed` to auto-generate a deterministic one.
   */
  readonly signer?: RealOkxSigner;
  /** Explicit credential — used to build a signer if `signer` not supplied. */
  readonly credential?: OkxCredential;
  /** Deterministic seed for credential generation when neither above is set. */
  readonly seed?: Uint8Array;
  /** Storage adapter for (userId → Instrument) bindings. */
  readonly instrumentStore: InstrumentStore;
  /** Reported balance in atomic units (offline default). Defaults to "0". */
  readonly balanceAtomic?: string;
  /** Optional broadcast hook. Omit for offline-safe deterministic settlement. */
  readonly submit?: OkxSubmitHook;
  /** Optional clock — overridable for deterministic tests. */
  readonly now?: () => number;
  /** Network label for telemetry. Defaults to "okx-pay-sandbox". */
  readonly network?: string;
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

export class OkxPayConnector implements WalletConnector {
  private readonly signer: RealOkxSigner;
  private readonly store: InstrumentStore;
  private readonly now: () => number;
  private readonly balanceAtomic: string;
  private readonly network: string;
  private readonly submit: OkxSubmitHook | undefined;

  constructor(private readonly config: OkxPayConnectorConfig) {
    this.signer =
      config.signer ??
      new RealOkxSigner({
        ...(config.credential !== undefined ? { credential: config.credential } : {}),
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
      });
    this.store = config.instrumentStore;
    this.now = config.now ?? Date.now;
    this.balanceAtomic = config.balanceAtomic ?? "0";
    this.network = config.network ?? "okx-pay-sandbox";
    this.submit = config.submit;
  }

  /** Public sub-account id (the publicHandle). */
  get subAccountId(): string {
    return this.signer.subAccountId;
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "OKX Pay",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_FOR_OKX],
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
    if (!input.userId) {
      throw new Error("userId is required");
    }

    // Idempotent: same userId → same instrument
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const instrument: Instrument = {
      id: this.makeInstrumentId(input.userId),
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.subAccountId,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        subAccountId: this.signer.subAccountId,
        apiKey: this.signer.apiKey,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const decimals = 6;
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDT", decimals },
      money: {
        amountAtomic: this.balanceAtomic,
        decimals,
        currency: "USDT",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an OAP-CEX authorization. Produces the wire token (HMAC-SHA256) that
   * goes in the X-PAYMENT-CEX header — the actual transfer happens in settle().
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    const instrument = await this.requireInstrument(input.instrumentId);
    if (input.request.protocol !== PROTOCOL_FOR_OKX) {
      throw new Error(
        `OkxPayConnector only supports protocol ${PROTOCOL_FOR_OKX}, got ${input.request.protocol}`
      );
    }

    const signedAt = Math.floor(this.now() / 1000);

    const authPayload: OkxAuthorizationPayload = {
      asset: input.request.asset.symbol,
      amount: input.request.amount.amountAtomic,
      amountDecimals: input.request.amount.decimals,
      from: instrument.publicHandle,
      to: input.request.recipient,
      nonce: input.request.nonce,
      validBefore: input.request.validBefore,
      signedAt,
    };

    // REAL HMAC-SHA256 signature (base64), verifiable with the secret.
    const signatureValue = this.signer.sign(authPayload);

    const wireToken: OapCexWireToken = {
      oapCexVersion: 1,
      scheme: "cex-pay",
      provider: "okx",
      authorization: authPayload,
      signature: { alg: OKX_SIGN_ALG, value: signatureValue },
    };

    return {
      request: input.request,
      signer: instrument.publicHandle,
      signature: signatureValue,
      encoded: encodeWireToken(wireToken),
      extra: { wireToken },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireToken = (signed.extra?.["wireToken"] ?? null) as OapCexWireToken | null;
    if (!wireToken) {
      return this.failure("missing wire token in signed.extra", "signature_invalid");
    }

    try {
      let transactionRef: string;
      let raw: unknown;

      if (this.submit) {
        const r = await this.submit({ wireToken, signed });
        transactionRef = r.transactionRef;
        raw = r.raw;
      } else {
        // Offline-safe deterministic receipt id derived from the signature.
        transactionRef = this.mockReceiptId(wireToken);
      }

      return {
        success: true,
        transactionRef: transactionRef as TransactionRef,
        network: this.network,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        ...(raw !== undefined ? { raw } : {}),
      };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; raw?: unknown };
      return {
        success: false,
        network: this.network,
        settledAt: nowIso(this.now()),
        errorCode: mapOkxErrorToCode(e.code),
        errorMessage: e.message ?? "okx-pay settlement error",
        ...(e.raw !== undefined ? { raw: e.raw } : {}),
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
    const hash = createHmac("sha256", this.signer.subAccountId)
      .update(userId)
      .digest("hex")
      .slice(0, 16);
    return `payment-instrument-okx-${hash}` as InstrumentId;
  }

  private mockReceiptId(wireToken: OapCexWireToken): string {
    const h = createHmac("sha256", "oap-okx-mock-receipt")
      .update(`${wireToken.signature.value}:${wireToken.authorization.nonce}`)
      .digest("hex")
      .slice(0, 24);
    return `okx-receipt-${h}`;
  }

  private failure(
    msg: string,
    errorCode: NonNullable<SettlementResult["errorCode"]>
  ): SettlementResult {
    return {
      success: false,
      network: this.network,
      settledAt: nowIso(this.now()),
      errorMessage: msg,
      errorCode,
    };
  }
}

// ============================================================================
//  helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}

/** "1000", 6 → "0.001000" */
function atomicToMajor(atomic: string, decimals: number): string {
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  return `${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

/** "19.958", 6 → "19958000" (atomic, stringified) */
function toAtomic(major: string, decimals: number): string {
  const [whole = "0", frac = ""] = major.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

function mapOkxErrorToCode(
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

// also expose helpers for unit testing
export const __internal = { toAtomic, atomicToMajor };
