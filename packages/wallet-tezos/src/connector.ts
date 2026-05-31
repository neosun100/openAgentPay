/**
 * Tezos Pay Protocol Adapter + Wallet Connector
 * ===============================================
 *
 * Non-EVM connector proving the WalletConnector + ProtocolAdapter abstractions
 * hold for the Tezos chain model:
 *
 *   - Crypto:      Ed25519 (tz1 implicit accounts)
 *   - Address:     base58check([0x06,0xA1,0x9F] || blake2b160(pubkey)) → "tz1..."
 *   - Asset:       XTZ, 6 decimals ("mutez" = micro-tez)
 *   - Settlement:  `transaction` operation — broadcast deferred behind a
 *                  pluggable signer (offline-safe, deterministic mock by default)
 *
 * Tezos Pay protocol ("tezos-pay-v1"): the 402 / merchant returns a Tezos Pay
 * URI of the shape:
 *
 *     tezos:<recipient>?amount=<decimal-xtz>&ref=<nonce>&label=<...>&message=<...>
 *
 * (Modelled on the Solana Pay URI shape; Tezos has no single canonical payment
 * URI standard, so we adopt the same ergonomic scheme.) The adapter parses the
 * URI → PaymentRequest; the WalletConnector signs Ed25519 + submits.
 *
 * PURE TypeScript — no taquito dependency. Real signing is wired through the
 * `RealTezosSigner`; production deployments supply a `submit` hook that injects
 * the operation via a Tezos RPC node.
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Instrument,
  type InstrumentId,
  type Money,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
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
  RealTezosSigner,
  canonicalTransferDescriptor,
  isValidTz1Address,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "tezos-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "tezos" as WalletProviderId;
export const X_PAYMENT_TEZOS_HEADER = "X-PAYMENT-TEZOS";

/** XTZ has 6 decimals: 1 XTZ = 1_000_000 mutez. */
export const XTZ_DECIMALS = 6;

const TEZOS_PAY_SCHEME = "tezos:";

// ============================================================================
//  Tezos Pay URI parser
// ============================================================================

export interface TezosPayUriFields {
  readonly recipient: string;
  readonly amount?: string; // decimal XTZ string, e.g. "1.5"
  readonly reference?: string;
  readonly label?: string;
  readonly message?: string;
  readonly memo?: string;
}

/**
 * Parse a Tezos Pay URI. Throws ProtocolError on malformed input.
 */
export function parseTezosPayUri(uri: string): TezosPayUriFields {
  if (typeof uri !== "string" || !uri.startsWith(TEZOS_PAY_SCHEME)) {
    throw new ProtocolError(
      `Tezos Pay URI must start with "${TEZOS_PAY_SCHEME}"`,
      "malformed"
    );
  }
  const afterScheme = uri.slice(TEZOS_PAY_SCHEME.length);
  const queryIdx = afterScheme.indexOf("?");
  const recipient = queryIdx >= 0 ? afterScheme.slice(0, queryIdx) : afterScheme;
  if (!recipient) {
    throw new ProtocolError("Tezos Pay URI missing recipient", "missing_field");
  }
  if (!isValidTz1Address(recipient)) {
    throw new ProtocolError(
      `Tezos Pay recipient is not a valid tz1 address: ${recipient}`,
      "malformed"
    );
  }
  const fields: {
    -readonly [K in keyof TezosPayUriFields]: TezosPayUriFields[K];
  } = { recipient };
  if (queryIdx < 0) return fields;

  const params = new URLSearchParams(afterScheme.slice(queryIdx + 1));
  for (const [k, v] of params.entries()) {
    switch (k) {
      case "amount": fields.amount = v; break;
      case "ref":
      case "reference": fields.reference = v; break;
      case "label": fields.label = v; break;
      case "message": fields.message = v; break;
      case "memo": fields.memo = v; break;
      default: /* ignore unknown */ break;
    }
  }
  return fields;
}

/** Build a Tezos Pay URI from fields. Inverse of `parseTezosPayUri`. */
export function buildTezosPayUri(fields: TezosPayUriFields): string {
  const params: string[] = [];
  if (fields.amount) params.push(`amount=${encodeURIComponent(fields.amount)}`);
  if (fields.reference) params.push(`ref=${encodeURIComponent(fields.reference)}`);
  if (fields.label) params.push(`label=${encodeURIComponent(fields.label)}`);
  if (fields.message) params.push(`message=${encodeURIComponent(fields.message)}`);
  if (fields.memo) params.push(`memo=${encodeURIComponent(fields.memo)}`);
  return `${TEZOS_PAY_SCHEME}${fields.recipient}${params.length ? "?" + params.join("&") : ""}`;
}

// ============================================================================
//  Tezos Pay ProtocolAdapter
// ============================================================================

export interface TezosPayAdapterConfig {
  /** Override clock for tests. */
  readonly now?: () => number;
}

export class TezosPayProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly now: () => number;

  constructor(cfg: TezosPayAdapterConfig = {}) {
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const uri = this.extractUri(response);
    return typeof uri === "string" && uri.startsWith(TEZOS_PAY_SCHEME);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const uri = this.extractUri(response);
    if (!uri) {
      throw new ProtocolError(
        "Tezos Pay URI not found in body or header",
        "missing_field"
      );
    }
    const fields = parseTezosPayUri(uri);
    if (!fields.amount) {
      throw new ProtocolError("Tezos Pay URI must specify ?amount=", "missing_field");
    }
    const amountAtomic = decimalToAtomic(fields.amount, XTZ_DECIMALS);
    const amount: Money = {
      amountAtomic,
      decimals: XTZ_DECIMALS,
      currency: "XTZ",
    };

    const validBefore = Math.floor(this.now() / 1000) + 600; // 10 min ttl
    const nonce = fields.reference ?? generateNonceHex();

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: fields.recipient,
      asset: { symbol: "XTZ", decimals: XTZ_DECIMALS, chain: "tezos:mainnet" },
      validAfter: 0,
      validBefore,
      nonce,
      rawPayload: { tezosPayUri: uri, fields },
      ...(fields.message ? { description: fields.message } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    // The Tezos wallet has already signed/broadcast — attach the edsig signature
    // (and opHash, if any) for the merchant to verify on-chain.
    const extra = (signed.extra ?? {}) as Record<string, unknown>;
    const opHash = typeof extra["opHash"] === "string" ? extra["opHash"] : signed.signature;
    return {
      headers: {
        [X_PAYMENT_TEZOS_HEADER]: signed.signature,
        "X-PAYMENT-TEZOS-OPHASH": opHash,
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // ---- Internals -----------------------------------------------------------

  private extractUri(response: HttpResponse402): string | undefined {
    const body = response.body as Record<string, unknown> | string | null;
    if (typeof body === "string" && body.startsWith(TEZOS_PAY_SCHEME)) return body;
    if (body && typeof body === "object") {
      const direct = (body as Record<string, unknown>)["tezosPay"];
      if (typeof direct === "string") return direct;
      const uri = (body as Record<string, unknown>)["uri"];
      if (typeof uri === "string" && uri.startsWith(TEZOS_PAY_SCHEME)) return uri;
    }
    const hdr = response.headers["x-tezos-pay-uri"];
    if (typeof hdr === "string") return hdr;
    return undefined;
  }
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

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "XTZ", decimals: XTZ_DECIMALS, chain: "tezos:mainnet" },
];

export interface TezosConnectorConfig {
  readonly signer: RealTezosSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "ghostnet";
  readonly now?: () => number;
}

export class TezosConnector implements WalletConnector {
  private readonly signer: RealTezosSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "ghostnet";
  private readonly now: () => number;

  constructor(cfg: TezosConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "ghostnet";
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Tezos (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; Temple/Kukai variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 30000, // ~30s block times on Tezos (Tenderbake)
      features: {
        nonEvm: true,
        ed25519: true,
        tz1: true,
        base58check: true,
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
    const id = `payment-instrument-tezos-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        publicKey: this.signer.publicKey,
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
      asset: { symbol: "XTZ", decimals: XTZ_DECIMALS, chain: "tezos:mainnet" },
      money: {
        amountAtomic: atomic.toString(),
        decimals: XTZ_DECIMALS,
        currency: "XTZ",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Tezos transfers are single-step (sign the operation, then inject). We split
   * to fit the 5-method interface: signAuthorization() produces the REAL Ed25519
   * signature over the canonical descriptor (and triggers the pluggable submit
   * hook, if present); settle() adapts the result to a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `TezosConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
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
        signatureHex: result.signatureHex,
        opHash: result.opHash,
        explorerUrl: result.explorerUrl,
        network: this.network,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    // signAuthorization already produced the signature (+ optional broadcast).
    if (!signed.signature) {
      return {
        success: false,
        network: `tezos-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing edsig signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const opHash =
      typeof e["opHash"] === "string" ? (e["opHash"] as string) : signed.signature;
    return {
      success: true,
      transactionRef: opHash as TransactionRef,
      network: `tezos-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        signatureHex: e["signatureHex"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Re-export of the canonical descriptor builder for callers that audit sigs. */
  descriptorFor(input: {
    recipient: string;
    amountAtomic: string;
    reference?: string;
    memo?: string;
  }): string {
    return canonicalTransferDescriptor({
      network: this.network,
      from: this.signer.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
  }

  generateNonce(): string {
    return generateNonceHex();
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

/** Convert decimal string like "1.5" with `decimals=6` → "1500000". */
function decimalToAtomic(decimal: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new ProtocolError(`Invalid decimal amount: ${decimal}`, "malformed");
  }
  const [whole = "0", frac = ""] = decimal.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole + fracPadded).replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

function generateNonceHex(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
