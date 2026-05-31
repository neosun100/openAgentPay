/**
 * @openagentpay/protocol-a2a-discovery — A2A Capability Discovery
 * ===============================================================
 *
 * Lets agents discover *each other's* payment capabilities BEFORE transacting
 * (Google AP2 A2A / agent-card pattern). An agent publishes an
 * `AgentPaymentCard` — which protocols / assets / wallets it accepts, optional
 * spend limits, and its AID/DID — and a counterparty fetches + validates it to
 * decide *how* to pay.
 *
 * This is a discovery/negotiation protocol, not a settlement protocol. It
 * composes with AP2 mandates and any inner settlement (x402 / MPP / OAP-CEX):
 * negotiate() picks the overlapping (protocol, asset, wallet) triple, then the
 * chosen settlement adapter does the actual signing.
 *
 * Wire format (v0.1) — a 402 carrying a discovery envelope:
 *   {
 *     "a2aVersion": "0.1",
 *     "agentCard": { ...AgentPaymentCard },
 *     "paymentRequest": {           // negotiated demand
 *       "protocol": "x402-v1",
 *       "recipient": "0x...",
 *       "amount": { "value": "1000", "currency": "USDC", "decimals": 6 },
 *       "asset": { "symbol": "USDC", "decimals": 6 },
 *       "walletProvider": "coinbase-cdp"
 *     }
 *   }
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Money,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
  type ProtocolId,
  type SignedAuthorization,
  type WalletProviderId,
} from "@openagentpay/core";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "a2a-discovery-v0.1" as ProtocolId;
export const X_PAYMENT_A2A_HEADER = "X-PAYMENT-A2A";
export const SUPPORTED_A2A_VERSIONS = ["0.1"] as const;

// ============================================================================
//  AgentPaymentCard — the published capability descriptor
// ============================================================================

/**
 * Optional spend ceiling an agent advertises (or a counterparty enforces).
 * Stored as atomic units to match `Money` precision rules.
 */
export interface AgentSpendLimits {
  /** Max per-transaction amount in atomic units (stringified bigint). */
  readonly maxPerTxAtomic: string;
  /** Currency / asset symbol the cap applies to. */
  readonly currency: string;
  /** Decimal places. */
  readonly decimals: number;
}

/**
 * An AgentPaymentCard is the self-describing "business card" an agent publishes
 * so counterparties know how to pay it (or how it will pay). Mirrors the AP2
 * A2A agent-card concept.
 */
export interface AgentPaymentCard {
  /** Stable agent identity — a DID or URI (e.g. "did:web:agent.example"). */
  readonly agentId: string;
  /** Human-readable label for UIs. */
  readonly displayName: string;
  /** Protocols this agent can settle through. */
  readonly acceptedProtocols: readonly ProtocolId[];
  /** Assets this agent accepts. */
  readonly acceptedAssets: readonly Asset[];
  /** Wallet providers this agent can transact with. */
  readonly acceptedWallets: readonly WalletProviderId[];
  /** Optional advertised spend ceiling. */
  readonly spendLimits?: AgentSpendLimits;
  /** Optional `.well-known` URL the card was (or can be) fetched from. */
  readonly wellKnownUrl?: string;
  /** Optional detached signature over the card (verified by a SignatureHook). */
  readonly signature?: string;
}

// ============================================================================
//  Discovery wire envelope
// ============================================================================

/**
 * The negotiated demand a publisher attaches to the discovery envelope. Names
 * mirror the MPP `amount` block so the two are visually consistent on the wire.
 */
export interface A2aNegotiatedRequest {
  readonly protocol: ProtocolId;
  readonly recipient: string;
  readonly amount: {
    readonly value: string;
    readonly currency: string;
    readonly decimals: number;
  };
  readonly asset: Asset;
  readonly walletProvider: WalletProviderId;
  readonly description?: string;
  readonly validBefore?: number;
  readonly nonce?: string;
}

export interface A2a402Body {
  readonly a2aVersion: string;
  readonly agentCard: AgentPaymentCard;
  /** The negotiated PaymentRequest the counterparty should satisfy. */
  readonly paymentRequest: A2aNegotiatedRequest;
}

// ============================================================================
//  Negotiation result
// ============================================================================

export interface NegotiationChoice {
  readonly protocol: ProtocolId;
  readonly asset: Asset;
  readonly walletProvider: WalletProviderId;
}

// ============================================================================
//  Pluggable signature hook
// ============================================================================

/**
 * Verifies an `AgentPaymentCard.signature`. Default implementation is
 * structural-only (accepts any present signature). Production replaces this
 * with a DID-resolving / JWS verifier.
 */
export interface CardSignatureHook {
  readonly name: string;
  verify(card: AgentPaymentCard): Promise<{ readonly valid: boolean; readonly reason?: string }>;
}

export class NullCardSignatureHook implements CardSignatureHook {
  readonly name = "NullCardSignatureHook";
  async verify(_card: AgentPaymentCard): Promise<{ valid: boolean }> {
    return { valid: true };
  }
}

// ============================================================================
//  Adapter config
// ============================================================================

export interface A2aDiscoveryAdapterConfig {
  /** Optional signature verifier — default: structural-only NullCardSignatureHook. */
  readonly signatureHook?: CardSignatureHook;
  /** Override clock for tests. */
  readonly now?: () => number;
}

// ============================================================================
//  Adapter implementation
// ============================================================================

export class A2aDiscoveryAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly signatureHook: CardSignatureHook;
  private readonly now: () => number;

  constructor(config: A2aDiscoveryAdapterConfig = {}) {
    this.signatureHook = config.signatureHook ?? new NullCardSignatureHook();
    this.now = config.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  //  ProtocolAdapter contract
  // -------------------------------------------------------------------------

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const v = body["a2aVersion"];
    if (typeof v !== "string" || !SUPPORTED_A2A_VERSIONS.includes(v as "0.1")) {
      return false;
    }
    return isObject(body["agentCard"]);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);

    const card = validateAgentCard(body.agentCard);
    const sig = await this.signatureHook.verify(card);
    if (!sig.valid) {
      throw new ProtocolError(
        `AgentPaymentCard ${card.agentId} failed signature verification: ${sig.reason ?? "unknown"}`,
        "malformed"
      );
    }

    const neg = body.paymentRequest;
    if (!isObject(neg)) {
      throw new ProtocolError("A2A discovery missing paymentRequest block", "missing_field");
    }
    if (typeof neg.recipient !== "string" || neg.recipient.length === 0) {
      throw new ProtocolError("A2A paymentRequest.recipient required", "missing_field");
    }
    if (!isObject(neg.amount)) {
      throw new ProtocolError("A2A paymentRequest.amount required", "missing_field");
    }
    if (typeof neg.amount.value !== "string") {
      throw new ProtocolError("A2A paymentRequest.amount.value must be a string", "missing_field");
    }

    // The publisher must only ask for what its own card accepts.
    if (!card.acceptedProtocols.includes(neg.protocol)) {
      throw new ProtocolError(
        `A2A paymentRequest.protocol ${neg.protocol} not in agentCard.acceptedProtocols`,
        "unsupported_scheme"
      );
    }

    // Enforce advertised spend limit (same-currency only).
    enforceSpendLimit(card.spendLimits, neg.amount.value, neg.amount.currency);

    const amount: Money = {
      amountAtomic: neg.amount.value,
      decimals: neg.amount.decimals,
      currency: neg.amount.currency,
    };
    const validBefore = neg.validBefore ?? Math.floor(this.now() / 1000) + 600;
    const nonce = neg.nonce ?? "0x" + bytesToHex(randomBytes(32));

    return {
      protocol: neg.protocol, // ⚠️ inner settlement protocol, not "a2a-discovery-v0.1"
      amount,
      recipient: neg.recipient,
      asset: neg.asset,
      validAfter: 0,
      validBefore,
      nonce,
      rawPayload: { a2aBody: body, agentCard: card },
      ...(neg.description !== undefined ? { description: neg.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("A2A retry requires a signature", "missing_field");
    }
    const wire = {
      a2aVersion: "0.1",
      settlement: {
        protocol: signed.request.protocol,
        signer: signed.signer,
        signature: signed.signature,
        encoded: signed.encoded ?? null,
      },
    };
    return {
      headers: {
        [X_PAYMENT_A2A_HEADER]: base64urlEncode(JSON.stringify(wire)),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // -------------------------------------------------------------------------
  //  Internals
  // -------------------------------------------------------------------------

  private assertBody(body: unknown): A2a402Body {
    if (!isObject(body)) {
      throw new ProtocolError("A2A body must be an object", "malformed");
    }
    if (typeof body["a2aVersion"] !== "string") {
      throw new ProtocolError("A2A missing a2aVersion", "missing_field");
    }
    if (!SUPPORTED_A2A_VERSIONS.includes(body["a2aVersion"] as "0.1")) {
      throw new ProtocolError(
        `A2A version ${body["a2aVersion"]} not supported (this adapter speaks ${SUPPORTED_A2A_VERSIONS.join(",")})`,
        "unsupported_version"
      );
    }
    if (!isObject(body["agentCard"])) {
      throw new ProtocolError("A2A missing agentCard", "missing_field");
    }
    return body as unknown as A2a402Body;
  }
}

// ============================================================================
//  Card helpers (parse / validate / negotiate)
// ============================================================================

/**
 * Parse a JSON string (or already-parsed object) into a validated
 * AgentPaymentCard. Throws ProtocolError on malformed input.
 */
export function parseAgentCard(json: string | unknown): AgentPaymentCard {
  let raw: unknown = json;
  if (typeof json === "string") {
    try {
      raw = JSON.parse(json);
    } catch {
      throw new ProtocolError("AgentPaymentCard JSON is not parseable", "malformed");
    }
  }
  return validateAgentCard(raw);
}

/**
 * Structural validation of an AgentPaymentCard. The signature itself is NOT
 * cryptographically checked here — that's the job of a CardSignatureHook.
 * Returns the card narrowed to `AgentPaymentCard` on success.
 */
export function validateAgentCard(card: unknown): AgentPaymentCard {
  if (!isObject(card)) {
    throw new ProtocolError("AgentPaymentCard must be an object", "malformed");
  }
  if (typeof card["agentId"] !== "string" || card["agentId"].length === 0) {
    throw new ProtocolError("AgentPaymentCard.agentId (DID/URI) required", "missing_field");
  }
  if (typeof card["displayName"] !== "string") {
    throw new ProtocolError("AgentPaymentCard.displayName required", "missing_field");
  }
  if (!isStringArray(card["acceptedProtocols"])) {
    throw new ProtocolError("AgentPaymentCard.acceptedProtocols must be a string[]", "missing_field");
  }
  if (!Array.isArray(card["acceptedAssets"])) {
    throw new ProtocolError("AgentPaymentCard.acceptedAssets must be an array", "missing_field");
  }
  for (const a of card["acceptedAssets"] as unknown[]) {
    if (!isObject(a) || typeof a["symbol"] !== "string" || typeof a["decimals"] !== "number") {
      throw new ProtocolError(
        "AgentPaymentCard.acceptedAssets entries require {symbol, decimals}",
        "malformed"
      );
    }
  }
  if (!isStringArray(card["acceptedWallets"])) {
    throw new ProtocolError("AgentPaymentCard.acceptedWallets must be a string[]", "missing_field");
  }
  const limits = card["spendLimits"];
  if (limits !== undefined) {
    if (
      !isObject(limits) ||
      typeof limits["maxPerTxAtomic"] !== "string" ||
      typeof limits["currency"] !== "string" ||
      typeof limits["decimals"] !== "number"
    ) {
      throw new ProtocolError(
        "AgentPaymentCard.spendLimits requires {maxPerTxAtomic, currency, decimals}",
        "malformed"
      );
    }
  }
  return card as unknown as AgentPaymentCard;
}

/**
 * Negotiate the overlapping (protocol, asset, walletProvider) between two cards.
 * `myCard` is the payer; `theirCard` is the counterparty being paid. Picks the
 * first protocol/wallet in `myCard`'s preference order that the other side also
 * accepts, plus the first mutually-accepted asset (matched by symbol).
 *
 * Throws ProtocolError("unsupported_scheme") when there is no overlap.
 */
export function negotiate(
  myCard: AgentPaymentCard,
  theirCard: AgentPaymentCard
): NegotiationChoice {
  const protocol = firstOverlap(myCard.acceptedProtocols, theirCard.acceptedProtocols);
  if (protocol === undefined) {
    throw new ProtocolError(
      `No overlapping protocol between ${myCard.agentId} and ${theirCard.agentId}`,
      "unsupported_scheme"
    );
  }
  const walletProvider = firstOverlap(myCard.acceptedWallets, theirCard.acceptedWallets);
  if (walletProvider === undefined) {
    throw new ProtocolError(
      `No overlapping wallet provider between ${myCard.agentId} and ${theirCard.agentId}`,
      "unsupported_scheme"
    );
  }
  const theirSymbols = new Set(theirCard.acceptedAssets.map((a) => a.symbol));
  const asset = myCard.acceptedAssets.find((a) => theirSymbols.has(a.symbol));
  if (asset === undefined) {
    throw new ProtocolError(
      `No overlapping asset between ${myCard.agentId} and ${theirCard.agentId}`,
      "unsupported_scheme"
    );
  }
  return { protocol, asset, walletProvider };
}

// ============================================================================
//  Helpers
// ============================================================================

function enforceSpendLimit(
  limits: AgentSpendLimits | undefined,
  amountAtomic: string,
  currency: string
): void {
  if (!limits) return;
  if (limits.currency !== currency) return; // limit only applies to its own currency
  let requested: bigint;
  let cap: bigint;
  try {
    requested = BigInt(amountAtomic);
    cap = BigInt(limits.maxPerTxAtomic);
  } catch {
    throw new ProtocolError("A2A amount / spendLimit not a valid integer", "malformed");
  }
  if (requested > cap) {
    throw new ProtocolError(
      `A2A amount ${amountAtomic} exceeds spendLimit ${limits.maxPerTxAtomic} ${currency}`,
      "unsupported_scheme"
    );
  }
}

function firstOverlap<T>(mine: readonly T[], theirs: readonly T[]): T | undefined {
  const set = new Set<T>(theirs);
  for (const x of mine) {
    if (set.has(x)) return x;
  }
  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function base64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
