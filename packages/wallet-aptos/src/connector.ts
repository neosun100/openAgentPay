/**
 * Aptos Pay Protocol Adapter + Wallet Connector
 * ===============================================
 *
 * A second non-EVM connector (after Solana) that further proves the
 * WalletConnector + ProtocolAdapter abstractions hold across chain models:
 *
 *   - Account model: 32-byte authentication-key accounts (Move VM resources)
 *   - Crypto: Ed25519 over a sha3_256 message digest
 *   - Address: "0x" + 64 hex (sha3_256(pubkey || 0x00)) — NOT base58 like Solana
 *   - Settlement: Move `0x1::coin::transfer<CoinType>` entry function
 *   - Recipient: "0x"-hex account address
 *
 * Still satisfies the same 5-method WalletConnector contract.
 *
 * Aptos Pay protocol (OAP convention):
 *   - 402 / merchant returns an Aptos Pay URL:
 *       aptos:<recipient>?amount=...&coin=...&reference=...&label=...&message=...
 *   - Adapter parses URL → PaymentRequest
 *   - WalletConnector signs Ed25519 + submits via fullnode (or wallet adapter)
 *
 * Implementation strategy: PURE TypeScript (no @aptos-labs/ts-sdk dependency)
 * for URL parsing + crypto. Real signing is in `real-signer.ts`; on-chain
 * broadcast is wired through the pluggable `submit` hook there.
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

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "aptos-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "aptos" as WalletProviderId;
export const X_PAYMENT_APTOS_HEADER = "X-PAYMENT-APTOS";

/** Native APT coin type (8 decimals). */
export const APT_COIN_TYPE = "0x1::aptos_coin::AptosCoin";
/** Circle USDC on Aptos testnet (6 decimals). */
const APTOS_USDC_TESTNET =
  "0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832::usdc::USDC";
/** Circle USDC on Aptos mainnet (6 decimals). */
const APTOS_USDC_MAINNET =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b::usdc::USDC";

// ============================================================================
//  Aptos Pay URL parser
// ============================================================================

export interface AptosPayUrlFields {
  readonly recipient: string;
  readonly amount?: string;        // decimal string, e.g., "0.001"
  readonly coin?: string;          // Move coin type tag
  readonly reference?: readonly string[];
  readonly label?: string;
  readonly message?: string;
  readonly memo?: string;
}

const APTOS_PAY_SCHEME = "aptos:";

/** An Aptos address is "0x" + 1..64 hex chars (we canonicalize to 64 elsewhere). */
function isLikelyAptosAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(s);
}

/**
 * Parse an Aptos Pay URL. Throws ProtocolError on malformed input.
 */
export function parseAptosPayUrl(url: string): AptosPayUrlFields {
  if (typeof url !== "string" || !url.startsWith(APTOS_PAY_SCHEME)) {
    throw new ProtocolError(
      `Aptos Pay URL must start with "${APTOS_PAY_SCHEME}"`,
      "malformed"
    );
  }
  const afterScheme = url.slice(APTOS_PAY_SCHEME.length);
  const queryIdx = afterScheme.indexOf("?");
  const recipient = queryIdx >= 0 ? afterScheme.slice(0, queryIdx) : afterScheme;
  if (!recipient) {
    throw new ProtocolError("Aptos Pay URL missing recipient", "missing_field");
  }
  if (!isLikelyAptosAddress(recipient)) {
    throw new ProtocolError(
      `Aptos Pay recipient is not a valid 0x address: ${recipient}`,
      "malformed"
    );
  }
  const fields: {
    -readonly [K in keyof AptosPayUrlFields]: AptosPayUrlFields[K];
  } = { recipient };
  if (queryIdx < 0) return fields;

  const params = new URLSearchParams(afterScheme.slice(queryIdx + 1));
  const refs: string[] = [];
  for (const [k, v] of params.entries()) {
    switch (k) {
      case "amount": fields.amount = v; break;
      case "coin": fields.coin = v; break;
      case "reference": refs.push(v); break;
      case "label": fields.label = v; break;
      case "message": fields.message = v; break;
      case "memo": fields.memo = v; break;
      default: /* ignore unknown */ break;
    }
  }
  if (refs.length > 0) fields.reference = refs;
  return fields;
}

/** Build an Aptos Pay URL from fields. Inverse of `parseAptosPayUrl`. */
export function buildAptosPayUrl(fields: AptosPayUrlFields): string {
  const params: string[] = [];
  if (fields.amount) params.push(`amount=${encodeURIComponent(fields.amount)}`);
  if (fields.coin) params.push(`coin=${encodeURIComponent(fields.coin)}`);
  if (fields.reference)
    for (const r of fields.reference) params.push(`reference=${encodeURIComponent(r)}`);
  if (fields.label) params.push(`label=${encodeURIComponent(fields.label)}`);
  if (fields.message) params.push(`message=${encodeURIComponent(fields.message)}`);
  if (fields.memo) params.push(`memo=${encodeURIComponent(fields.memo)}`);
  return `${APTOS_PAY_SCHEME}${fields.recipient}${params.length ? "?" + params.join("&") : ""}`;
}

// ============================================================================
//  Aptos Pay ProtocolAdapter
// ============================================================================

export interface AptosPayAdapterConfig {
  /** Coin types treated as the "stable" 6-decimal USDC token. */
  readonly knownStableCoins?: readonly string[];
  /** Override clock for tests. */
  readonly now?: () => number;
}

/**
 * AptosPayProtocolAdapter — recognizes 402 envelopes carrying an Aptos Pay
 * URL and produces a wallet-agnostic PaymentRequest.
 *
 * Wire format we accept: { aptosPay: "<URL>", ... } in body, raw string body,
 * or `x-aptos-pay-url` header.
 */
export class AptosPayProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly knownStableCoins: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(cfg: AptosPayAdapterConfig = {}) {
    this.knownStableCoins = new Set(
      cfg.knownStableCoins ?? [APTOS_USDC_TESTNET, APTOS_USDC_MAINNET]
    );
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const url = this.extractUrl(response);
    return typeof url === "string" && url.startsWith(APTOS_PAY_SCHEME);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const url = this.extractUrl(response);
    if (!url) {
      throw new ProtocolError(
        "Aptos Pay URL not found in body or header",
        "missing_field"
      );
    }
    const fields = parseAptosPayUrl(url);
    if (!fields.amount) {
      throw new ProtocolError("Aptos Pay URL must specify ?amount=", "missing_field");
    }
    const isNative = !fields.coin || fields.coin === APT_COIN_TYPE;
    const isUsdc = fields.coin ? this.knownStableCoins.has(fields.coin) : false;
    const decimals = isNative ? 8 : isUsdc ? 6 : 8; // APT=8dp, USDC=6dp, default 8
    const currency = isNative ? "APT" : isUsdc ? "USDC" : "COIN";
    const amountAtomic = decimalToAtomic(fields.amount, decimals);
    const amount: Money = { amountAtomic, decimals, currency };

    const validBefore = Math.floor(this.now() / 1000) + 600; // 10 min ttl
    const nonce = fields.reference?.[0] ?? generateNonceHex();

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: fields.recipient,
      asset: {
        symbol: currency,
        decimals,
        ...(fields.coin && !isNative ? { contract: fields.coin } : {}),
      },
      validAfter: 0,
      validBefore,
      nonce,
      rawPayload: { aptosPayUrl: url, fields },
      ...(fields.message ? { description: fields.message } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    // Aptos tx already broadcast (single-shot model) — attach the tx signature
    // for the merchant to verify on-chain.
    return {
      headers: {
        [X_PAYMENT_APTOS_HEADER]: signed.signature,
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // ---- Internals -----------------------------------------------------------

  private extractUrl(response: HttpResponse402): string | undefined {
    const body = response.body as Record<string, unknown> | string | null;
    if (typeof body === "string" && body.startsWith(APTOS_PAY_SCHEME)) return body;
    if (body && typeof body === "object") {
      const direct = (body as Record<string, unknown>)["aptosPay"];
      if (typeof direct === "string") return direct;
      const url = (body as Record<string, unknown>)["url"];
      if (typeof url === "string" && url.startsWith(APTOS_PAY_SCHEME)) return url;
    }
    const hdr = response.headers["x-aptos-pay-url"];
    if (typeof hdr === "string") return hdr;
    return undefined;
  }
}

// ============================================================================
//  Aptos signer abstraction (pluggable)
// ============================================================================

export interface AptosSigner {
  /** "0x"-hex account address. */
  readonly address: string;
  /** "0x"-hex Ed25519 public key. */
  readonly publicKeyHex: string;
  /**
   * Sign + (optionally) submit an Aptos coin transfer. Implementations:
   *   - DemoAptosSigner (this file) — fake signature for unit tests
   *   - RealAptosSigner (real-signer.ts) — real Ed25519, pluggable broadcast
   *   - @aptos-labs/ts-sdk based signer (production)
   *   - Wallet adapter (Petra / Pontem / Martian browser wallet)
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly coinType?: string;
    readonly reference?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signature: string;
    readonly version?: number;
    readonly explorerUrl?: string;
  }>;
  getBalance(coinType?: string): Promise<bigint>;
}

/**
 * In-memory signer for unit tests. Generates a deterministic-ish signature by
 * concatenating inputs — never used in production.
 */
export class DemoAptosSigner implements AptosSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  private balance: bigint;
  constructor(opts: { address?: string; publicKeyHex?: string; initialBalanceAtomic?: string } = {}) {
    this.address = opts.address ?? "0x" + "ab".repeat(32);
    this.publicKeyHex = opts.publicKeyHex ?? "0x" + "cd".repeat(32);
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    coinType?: string;
    reference?: string;
  }) {
    const sig = "0xDEMOSIG" + (input.reference ?? input.recipient).slice(0, 16);
    return {
      signature: sig,
      version: 1,
      explorerUrl: `https://explorer.aptoslabs.com/txn/${sig}?network=testnet`,
    };
  }
  async getBalance(): Promise<bigint> {
    return this.balance;
  }
  /** Test helper. */
  setBalance(atomic: string) {
    this.balance = BigInt(atomic);
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
  { symbol: "APT", decimals: 8 },
  { symbol: "USDC", decimals: 6 },
];

export interface AptosConnectorConfig {
  readonly signer: AptosSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet" | "devnet";
  readonly defaultCoinType?: string;
  readonly now?: () => number;
}

export class AptosConnector implements WalletConnector {
  private readonly signer: AptosSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet" | "devnet";
  private readonly defaultCoinType: string;
  private readonly now: () => number;

  constructor(cfg: AptosConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultCoinType = cfg.defaultCoinType ?? APT_COIN_TYPE;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Aptos (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; mobile wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 1000, // ~1s finality on Aptos
      features: {
        nonEvm: true,
        ed25519: true,
        moveVm: true,
        nativeApt: true,
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
    const id = `payment-instrument-aptos-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultCoinType: this.defaultCoinType,
        publicKey: this.signer.publicKeyHex,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultCoinType);
    const isApt = this.defaultCoinType === APT_COIN_TYPE;
    return {
      instrumentId: inst.id,
      asset: {
        symbol: isApt ? "APT" : "USDC",
        decimals: isApt ? 8 : 6,
        ...(isApt ? {} : { contract: this.defaultCoinType }),
      },
      money: {
        amountAtomic: atomic.toString(),
        decimals: isApt ? 8 : 6,
        currency: isApt ? "APT" : "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Aptos transactions are single-step: the wallet builds + signs a Move
   * `coin::transfer` in one shot. We split the flow to fit our 5-method
   * interface: signAuthorization() produces the signed intent (broadcast
   * deferred when no submit hook is wired), settle() returns the receipt.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `AptosConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const coinType =
      input.request.asset.contract ??
      (input.request.asset.symbol === "APT" ? APT_COIN_TYPE : this.defaultCoinType);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(coinType !== undefined ? { coinType } : {}),
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
        version: result.version ?? 0,
        explorerUrl: result.explorerUrl ?? "",
        network: this.network,
        publicKey: this.signer.publicKeyHex,
        coinType,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    // signAuthorization already produced the signed tx (Aptos single-shot model).
    if (!signed.signature) {
      return {
        success: false,
        network: `aptos-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing tx signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    return {
      success: true,
      transactionRef: signed.signature as TransactionRef,
      network: `aptos-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        version: e["version"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

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

/** Convert decimal string like "0.001" with `decimals=6` → "1000". */
function decimalToAtomic(decimal: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new ProtocolError(`Invalid decimal amount: ${decimal}`, "malformed");
  }
  const [whole = "0", frac = ""] = decimal.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole + fracPadded).replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/** 32-byte random nonce as "0x"-hex. */
function generateNonceHex(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
