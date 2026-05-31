/**
 * TON Pay Protocol Adapter + Wallet Connector
 * ============================================
 *
 * Non-EVM connector proving the WalletConnector + ProtocolAdapter abstractions
 * hold for TON (The Open Network):
 *
 *   - Account model: TON's actor/contract model (each wallet is a smart contract)
 *   - Crypto: Ed25519 (like Solana/Stellar), NOT secp256k1
 *   - Address: 48-char base64url user-friendly form (tag/workchain/crc16)
 *   - Assets: native TON (9 decimals) + USDT jetton (6 decimals)
 *   - Settlement: external message → wallet contract (kept pluggable)
 *
 * ton-pay-v1 protocol:
 *   - 402 / merchant returns a `ton://transfer/<address>?amount=...&jetton=...&text=...`
 *     deep-link URL (the de-facto TON payment URL scheme), OR a JSON envelope.
 *   - Adapter parses URL → PaymentRequest.
 *   - WalletConnector signs Ed25519 + (optionally) broadcasts.
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

import { isValidTonAddress } from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "ton-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "ton" as WalletProviderId;
export const X_PAYMENT_TON_HEADER = "X-PAYMENT-TON";

const TON_PAY_SCHEME = "ton://transfer/";

// Well-known USDT jetton master on TON (mainnet). Used to recognize the
// "stable" jetton; testnet deployments override via knownJettons.
const TON_USDT_MAINNET = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

// ============================================================================
//  ton-pay URL parser
// ============================================================================

export interface TonPayUrlFields {
  readonly recipient: string;
  readonly amount?: string; // decimal string, e.g. "0.5"
  readonly jetton?: string; // jetton master address
  readonly text?: string; // comment / message
  readonly nonce?: string;
}

/**
 * Parse a `ton://transfer/<address>?amount=...&jetton=...&text=...` URL.
 * Throws ProtocolError on malformed input.
 */
export function parseTonPayUrl(url: string): TonPayUrlFields {
  if (typeof url !== "string" || !url.startsWith(TON_PAY_SCHEME)) {
    throw new ProtocolError(
      `TON Pay URL must start with "${TON_PAY_SCHEME}"`,
      "malformed"
    );
  }
  const afterScheme = url.slice(TON_PAY_SCHEME.length);
  const queryIdx = afterScheme.indexOf("?");
  const recipient = queryIdx >= 0 ? afterScheme.slice(0, queryIdx) : afterScheme;
  if (!recipient) {
    throw new ProtocolError("TON Pay URL missing recipient", "missing_field");
  }
  if (!isValidTonAddress(recipient)) {
    throw new ProtocolError(
      `TON Pay recipient is not a valid TON address: ${recipient}`,
      "malformed"
    );
  }
  const fields: {
    -readonly [K in keyof TonPayUrlFields]: TonPayUrlFields[K];
  } = { recipient };
  if (queryIdx < 0) return fields;

  const params = new URLSearchParams(afterScheme.slice(queryIdx + 1));
  for (const [k, v] of params.entries()) {
    switch (k) {
      case "amount":
        fields.amount = v;
        break;
      case "jetton":
        fields.jetton = v;
        break;
      case "text":
        fields.text = v;
        break;
      case "nonce":
        fields.nonce = v;
        break;
      default:
        break;
    }
  }
  return fields;
}

/** Build a ton-pay URL from fields. Inverse of `parseTonPayUrl`. */
export function buildTonPayUrl(fields: TonPayUrlFields): string {
  const params: string[] = [];
  if (fields.amount) params.push(`amount=${encodeURIComponent(fields.amount)}`);
  if (fields.jetton) params.push(`jetton=${encodeURIComponent(fields.jetton)}`);
  if (fields.text) params.push(`text=${encodeURIComponent(fields.text)}`);
  if (fields.nonce) params.push(`nonce=${encodeURIComponent(fields.nonce)}`);
  return `${TON_PAY_SCHEME}${fields.recipient}${
    params.length ? "?" + params.join("&") : ""
  }`;
}

// ============================================================================
//  ton-pay ProtocolAdapter
// ============================================================================

export interface TonPayAdapterConfig {
  /** Jetton master address(es) considered the "stable" (USDT) token. */
  readonly knownJettons?: readonly string[];
  /** Override clock for tests. */
  readonly now?: () => number;
}

export class TonPayProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly knownJettons: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(cfg: TonPayAdapterConfig = {}) {
    this.knownJettons = new Set(cfg.knownJettons ?? [TON_USDT_MAINNET]);
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const url = this.extractUrl(response);
    return typeof url === "string" && url.startsWith(TON_PAY_SCHEME);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const url = this.extractUrl(response);
    if (!url) {
      throw new ProtocolError(
        "TON Pay URL not found in body or header",
        "missing_field"
      );
    }
    const fields = parseTonPayUrl(url);
    if (!fields.amount) {
      throw new ProtocolError("TON Pay URL must specify ?amount=", "missing_field");
    }
    const isUsdt = fields.jetton ? this.knownJettons.has(fields.jetton) : false;
    const decimals = isUsdt ? 6 : 9; // USDT jetton = 6 dp, native TON = 9 dp
    const currency = isUsdt ? "USDT" : fields.jetton ? "JETTON" : "TON";
    const amountAtomic = decimalToAtomic(fields.amount, decimals);
    const amount: Money = { amountAtomic, decimals, currency };

    const validBefore = Math.floor(this.now() / 1000) + 600; // 10 min ttl
    const nonce = fields.nonce ?? generateNonceHex();

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: fields.recipient,
      asset: {
        symbol: currency,
        decimals,
        ...(fields.jetton ? { contract: fields.jetton } : {}),
      },
      validAfter: 0,
      validBefore,
      nonce,
      rawPayload: { tonPayUrl: url, fields },
      ...(fields.text ? { description: fields.text } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    return {
      headers: {
        [X_PAYMENT_TON_HEADER]: signed.signature,
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // ---- Internals -----------------------------------------------------------

  private extractUrl(response: HttpResponse402): string | undefined {
    const body = response.body as Record<string, unknown> | string | null;
    if (typeof body === "string" && body.startsWith(TON_PAY_SCHEME)) return body;
    if (body && typeof body === "object") {
      const direct = (body as Record<string, unknown>)["tonPay"];
      if (typeof direct === "string") return direct;
      const url = (body as Record<string, unknown>)["url"];
      if (typeof url === "string" && url.startsWith(TON_PAY_SCHEME)) return url;
    }
    const hdr = response.headers["x-ton-pay-url"];
    if (typeof hdr === "string") return hdr;
    return undefined;
  }
}

// ============================================================================
//  TON signer abstraction (pluggable)
// ============================================================================

export interface TonSigner {
  /** User-friendly base64url TON address (48 chars). */
  readonly address: string;
  /** 32-byte public key, hex. */
  readonly publicKeyHex: string;
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly jettonMaster?: string;
    readonly comment?: string;
    readonly seqno?: number;
  }): Promise<{
    readonly signature: string;
    readonly txHash?: string;
    readonly explorerUrl?: string;
  }>;
  getBalance(jettonMaster?: string): Promise<bigint>;
}

/**
 * In-memory signer for tests. Produces a deterministic-ish fake signature —
 * never used in production. (Real cryptographic signing lives in RealTonSigner.)
 */
export class DemoTonSigner implements TonSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  private balance: bigint;
  constructor(opts: { address?: string; publicKeyHex?: string; initialBalanceAtomic?: string } = {}) {
    // A valid-looking placeholder; real flows use RealTonSigner.
    this.address = opts.address ?? "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    this.publicKeyHex = opts.publicKeyHex ?? "00".repeat(32);
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    jettonMaster?: string;
    comment?: string;
  }) {
    const tx = "DEMOTX_" + (input.comment ?? input.recipient).slice(0, 16);
    return {
      signature: "DEMOSIG_" + input.recipient.slice(0, 16),
      txHash: tx,
      explorerUrl: `https://testnet.tonviewer.com/transaction/${tx}`,
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
  { symbol: "TON", decimals: 9 },
  { symbol: "USDT", decimals: 6 },
];

export interface TonConnectorConfig {
  readonly signer: TonSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet";
  /** Default jetton master used for balance reads (USDT). */
  readonly defaultJetton?: string;
  readonly now?: () => number;
}

export class TonConnector implements WalletConnector {
  private readonly signer: TonSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet";
  private readonly defaultJetton: string;
  private readonly now: () => number;

  constructor(cfg: TonConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultJetton = cfg.defaultJetton ?? TON_USDT_MAINNET;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `TON (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; TonConnect mobile variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 5000, // ~5s masterchain finality on TON
      features: {
        nonEvm: true,
        ed25519: true,
        nativeTon: true,
        jetton: true,
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
    const id = `payment-instrument-ton-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        publicKeyHex: this.signer.publicKeyHex,
        defaultJetton: this.defaultJetton,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultJetton);
    return {
      instrumentId: inst.id,
      asset: { symbol: "USDT", decimals: 6, contract: this.defaultJetton },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDT",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * TON is single-step at the wallet layer (sign external message → broadcast).
   * We split it across our 5-method interface: signAuthorization() signs (and,
   * if a `submit` hook is wired, broadcasts) producing the receipt; settle()
   * adapts that receipt into a SettlementResult.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `TonConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const jettonMaster =
      input.request.asset.contract ??
      (input.request.asset.symbol === "TON" ? undefined : this.defaultJetton);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(jettonMaster !== undefined ? { jettonMaster } : {}),
      comment: input.request.nonce,
      ...(input.request.description !== undefined
        ? { comment: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signature,
      extra: {
        txHash: result.txHash ?? "",
        explorerUrl: result.explorerUrl ?? "",
        network: this.network,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `ton-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing TON signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const txHash =
      typeof e["txHash"] === "string" && e["txHash"]
        ? (e["txHash"] as string)
        : signed.signature;
    return {
      success: true,
      transactionRef: txHash as TransactionRef,
      network: `ton-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        explorerUrl: e["explorerUrl"],
        signature: signed.signature,
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

/** Convert decimal string like "0.5" with `decimals=9` → "500000000". */
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
