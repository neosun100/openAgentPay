/**
 * Solana Pay Protocol Adapter + Wallet Connector
 * ================================================
 *
 * Non-EVM connector that proves the WalletConnector + ProtocolAdapter
 * abstractions hold across radically different chain models:
 *
 *   - Account model: stateful (EVM nonces) → stateless (Solana sysvar nonces / blockhash)
 *   - Crypto: secp256k1 ECDSA (EVM) → Ed25519 (Solana)
 *   - Settlement: smart-contract call (EVM) → SPL Token Program transfer
 *   - Recipient: 0x… (EVM) → base58 32-byte pubkey (Solana)
 *
 * Both still satisfy the same 5-method WalletConnector contract.
 *
 * Solana Pay protocol:
 *   - 402 / merchant returns a Solana Pay URL: solana:<recipient>?amount=...&spl-token=...&reference=...&label=...&message=...
 *   - Spec: https://docs.solanapay.com/spec
 *   - Adapter parses URL → PaymentRequest
 *   - WalletConnector signs Ed25519 + submits via RPC (or hands off to wallet adapter)
 *
 * Implementation strategy: PURE TypeScript (no @solana/web3.js dependency)
 * for the URL parsing + base58 helpers. Real signing/submission is wired
 * through a pluggable `SolanaSigner` interface that production deployments
 * back with @solana/web3.js or wallet adapter SDKs.
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

export const PROTOCOL_ID = "solana-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "solana" as WalletProviderId;
export const X_PAYMENT_SOLANA_HEADER = "X-PAYMENT-SOLANA";

const SOLANA_USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDC_DEVNET = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

// ============================================================================
//  Solana Pay URL parser
// ============================================================================

export interface SolanaPayUrlFields {
  readonly recipient: string;
  readonly amount?: string;        // decimal string, e.g., "0.001"
  readonly splToken?: string;      // mint pubkey
  readonly reference?: readonly string[];
  readonly label?: string;
  readonly message?: string;
  readonly memo?: string;
}

const SOLANA_PAY_SCHEME = "solana:";

/**
 * Parse a Solana Pay URL per https://docs.solanapay.com/spec.
 * Throws ProtocolError on malformed input.
 */
export function parseSolanaPayUrl(url: string): SolanaPayUrlFields {
  if (typeof url !== "string" || !url.startsWith(SOLANA_PAY_SCHEME)) {
    throw new ProtocolError(
      `Solana Pay URL must start with "${SOLANA_PAY_SCHEME}"`,
      "malformed"
    );
  }
  const afterScheme = url.slice(SOLANA_PAY_SCHEME.length);
  const queryIdx = afterScheme.indexOf("?");
  const recipient = queryIdx >= 0 ? afterScheme.slice(0, queryIdx) : afterScheme;
  if (!recipient) {
    throw new ProtocolError("Solana Pay URL missing recipient", "missing_field");
  }
  if (!isLikelyBase58(recipient)) {
    throw new ProtocolError(
      `Solana Pay recipient is not valid base58: ${recipient}`,
      "malformed"
    );
  }
  const fields: {
    -readonly [K in keyof SolanaPayUrlFields]: SolanaPayUrlFields[K];
  } = { recipient };
  if (queryIdx < 0) return fields;

  const params = new URLSearchParams(afterScheme.slice(queryIdx + 1));
  const refs: string[] = [];
  for (const [k, v] of params.entries()) {
    switch (k) {
      case "amount": fields.amount = v; break;
      case "spl-token": fields.splToken = v; break;
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

/**
 * Build a Solana Pay URL from fields. Inverse of `parseSolanaPayUrl`.
 */
export function buildSolanaPayUrl(fields: SolanaPayUrlFields): string {
  const params: string[] = [];
  if (fields.amount) params.push(`amount=${encodeURIComponent(fields.amount)}`);
  if (fields.splToken) params.push(`spl-token=${encodeURIComponent(fields.splToken)}`);
  if (fields.reference)
    for (const r of fields.reference) params.push(`reference=${encodeURIComponent(r)}`);
  if (fields.label) params.push(`label=${encodeURIComponent(fields.label)}`);
  if (fields.message) params.push(`message=${encodeURIComponent(fields.message)}`);
  if (fields.memo) params.push(`memo=${encodeURIComponent(fields.memo)}`);
  return `${SOLANA_PAY_SCHEME}${fields.recipient}${params.length ? "?" + params.join("&") : ""}`;
}

// Simple base58 character-set check — sufficient to reject obviously bogus inputs.
function isLikelyBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) && s.length >= 32 && s.length <= 44;
}

// ============================================================================
//  Solana Pay ProtocolAdapter
// ============================================================================

export interface SolanaPayAdapterConfig {
  /** Allow USDC mint address(es) to be considered the "stable" token. */
  readonly knownStableMints?: readonly string[];
  /** Override clock for tests. */
  readonly now?: () => number;
}

/**
 * SolanaPayProtocolAdapter — recognizes 402 envelopes carrying a Solana Pay
 * URL and produces a wallet-agnostic PaymentRequest.
 *
 * Wire format we accept: { solanaPay: "<URL>", ... } in body OR
 * Content-Type 'application/x-solana-pay' with raw URL body.
 */
export class SolanaPayProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly knownStableMints: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(cfg: SolanaPayAdapterConfig = {}) {
    this.knownStableMints = new Set(
      cfg.knownStableMints ?? [SOLANA_USDC_MAINNET, SOLANA_USDC_DEVNET]
    );
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const url = this.extractUrl(response);
    return typeof url === "string" && url.startsWith(SOLANA_PAY_SCHEME);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const url = this.extractUrl(response);
    if (!url) {
      throw new ProtocolError(
        "Solana Pay URL not found in body or header",
        "missing_field"
      );
    }
    const fields = parseSolanaPayUrl(url);
    if (!fields.amount) {
      throw new ProtocolError("Solana Pay URL must specify ?amount=", "missing_field");
    }
    const isUsdcMint = fields.splToken
      ? this.knownStableMints.has(fields.splToken)
      : false;
    const decimals = isUsdcMint ? 6 : 9; // USDC=6 dp, native SOL=9 dp
    const currency = isUsdcMint ? "USDC" : fields.splToken ? "SPL" : "SOL";
    const amountAtomic = decimalToAtomic(fields.amount, decimals);
    const amount: Money = { amountAtomic, decimals, currency };

    const validBefore = Math.floor(this.now() / 1000) + 600; // 10 min ttl
    const nonce = (fields.reference?.[0]) ?? generateRefBase58();

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: fields.recipient,
      asset: {
        symbol: currency,
        decimals,
        ...(fields.splToken ? { contract: fields.splToken } : {}),
      },
      validAfter: 0,
      validBefore,
      nonce,
      rawPayload: { solanaPayUrl: url, fields },
      ...(fields.message ? { description: fields.message } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    // Solana wallet has already broadcast — just attach the tx signature
    // (`signed.signature`) for the merchant to verify on-chain.
    return {
      headers: {
        [X_PAYMENT_SOLANA_HEADER]: signed.signature,
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // ---- Internals -----------------------------------------------------------

  private extractUrl(response: HttpResponse402): string | undefined {
    const body = response.body as Record<string, unknown> | string | null;
    if (typeof body === "string" && body.startsWith(SOLANA_PAY_SCHEME)) return body;
    if (body && typeof body === "object") {
      const direct = (body as Record<string, unknown>)["solanaPay"];
      if (typeof direct === "string") return direct;
      const url = (body as Record<string, unknown>)["url"];
      if (typeof url === "string" && url.startsWith(SOLANA_PAY_SCHEME)) return url;
    }
    const hdr = response.headers["x-solana-pay-url"];
    if (typeof hdr === "string") return hdr;
    return undefined;
  }
}

// ============================================================================
//  Solana signer abstraction (pluggable)
// ============================================================================

export interface SolanaSigner {
  /** base58 public key. */
  readonly address: string;
  /**
   * Sign + submit a Solana Pay transfer. Implementations:
   *   - DemoSolanaSigner (this file) — fake signature for tests
   *   - @solana/web3.js based signer (production)
   *   - Wallet adapter (Phantom / Solflare / Backpack browser wallet)
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly splTokenMint?: string;
    readonly reference?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signature: string;
    readonly slot?: number;
    readonly explorerUrl?: string;
  }>;
  getBalance(splTokenMint?: string): Promise<bigint>;
}

/**
 * In-memory signer for tests. Generates a deterministic-ish signature by
 * concatenating inputs — never used in production.
 */
export class DemoSolanaSigner implements SolanaSigner {
  readonly address: string;
  private balance: bigint;
  constructor(opts: { address?: string; initialBalanceAtomic?: string } = {}) {
    this.address = opts.address ?? "DEMO11111111111111111111111111111111111111";
    this.balance = BigInt(opts.initialBalanceAtomic ?? "0");
  }
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    splTokenMint?: string;
    reference?: string;
  }) {
    const sig = "DEMOSIG_" + (input.reference ?? input.recipient).slice(0, 16);
    return {
      signature: sig,
      slot: 1,
      explorerUrl: `https://explorer.solana.com/tx/${sig}`,
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
  { symbol: "USDC", decimals: 6 },
  { symbol: "SOL", decimals: 9 },
];

export interface SolanaConnectorConfig {
  readonly signer: SolanaSigner;
  readonly instrumentStore: InstrumentStore;
  readonly cluster?: "mainnet-beta" | "devnet" | "testnet";
  readonly defaultMint?: string;
  readonly now?: () => number;
}

export class SolanaConnector implements WalletConnector {
  private readonly signer: SolanaSigner;
  private readonly store: InstrumentStore;
  private readonly cluster: "mainnet-beta" | "devnet" | "testnet";
  private readonly defaultMint: string;
  private readonly now: () => number;

  constructor(cfg: SolanaConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.cluster = cfg.cluster ?? "devnet";
    this.defaultMint = cfg.defaultMint ?? SOLANA_USDC_DEVNET;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Solana (${this.cluster})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side signer; mobile wallet variant overrides
      settlesOnChain: true,
      typicalLatencyMs: 1000, // ~400ms slot times on Solana
      features: {
        nonEvm: true,
        ed25519: true,
        nativeSol: true,
        splToken: true,
        cluster: this.cluster,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    const existing = await this.store.get(input.userId);
    if (existing) return existing;
    const id = `payment-instrument-solana-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        cluster: this.cluster,
        defaultMint: this.defaultMint,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultMint);
    return {
      instrumentId: inst.id,
      asset: { symbol: "USDC", decimals: 6, contract: this.defaultMint },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Solana Pay is single-step: there's no separate "sign authorization" then
   * "settle" — the wallet builds a tx and signs it in one shot. We split the
   * flow to fit our 5-method interface: signAuthorization() builds the
   * intent (no submission), settle() executes it.
   *
   * For demo simplicity, both steps go through `signer.signAndSubmit()` —
   * which DOES submit. signAuthorization caches the result as a future
   * receipt; settle returns it.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `SolanaConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    const splTokenMint =
      input.request.asset.contract ??
      (input.request.asset.symbol === "SOL" ? undefined : this.defaultMint);
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(splTokenMint !== undefined ? { splTokenMint } : {}),
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
        slot: result.slot ?? 0,
        explorerUrl: result.explorerUrl ?? "",
        cluster: this.cluster,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    // signAuthorization already did the broadcast (Solana single-shot model).
    // Just adapt the result.
    if (!signed.signature) {
      return {
        success: false,
        network: `solana-${this.cluster}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing tx signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    return {
      success: true,
      transactionRef: signed.signature as TransactionRef,
      network: `solana-${this.cluster}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        slot: e["slot"],
        explorerUrl: e["explorerUrl"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

  generateNonce(): string {
    return generateRefBase58();
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

function generateRefBase58(): string {
  // 32-byte random in base58. We use a simple alphabet-rotating fallback
  // to avoid pulling in a base58 dep — sufficient for nonces.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
