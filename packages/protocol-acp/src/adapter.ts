/**
 * @openagentpay/protocol-acp — Agentic Commerce Protocol (OpenAI + Stripe)
 * =========================================================================
 *
 * ACP is the agent-commerce standard jointly published by OpenAI and Stripe.
 * Instead of a bare "pay N tokens to address X" 402 (cf. x402 / MPP), ACP
 * layers *cart semantics* on top of a settlement rail: the merchant returns a
 * signed **checkout session** — a cart commitment listing line items, a total,
 * and the settlement rail (stablecoin or card). The agent confirms the session
 * and pays; the session id binds the confirmation back to the merchant cart.
 *
 * Wire format (v0.1):
 *   {
 *     "acpVersion": "0.1",
 *     "checkoutSessionId": "cs_acp_...",
 *     "merchant": { "id": "...", "name": "..." },
 *     "lineItems": [
 *       { "name": "Widget", "quantity": 2, "unitAmount": { "value": "500", "currency": "USDC", "decimals": 6 } }
 *     ],
 *     "total": { "value": "1000", "currency": "USDC", "decimals": 6 },
 *     "settlement": { "rail": "stablecoin" | "card", "recipient": "0x..." },
 *     "expiresAt": 1893456000   // optional, Unix seconds
 *   }
 *
 * ── Composition with AP2 CartMandate ───────────────────────────────────────
 * An ACP checkout session is functionally an AP2 `CartMandate`: both express a
 * cart commitment (line items + total) that an agent confirms before paying.
 * They differ only in *ecosystem* — AP2 is Google's mandate envelope carried
 * orthogonally on `PaymentRequest.mandates`, while ACP is OpenAI/Stripe's
 * inline checkout-session shape. OpenAgentPay supports BOTH: an ACP cart can be
 * surfaced as an AP2 CartMandate (or vice-versa) by an upstream translator —
 * this adapter maps the ACP `total` into the canonical atomic `Money` of a
 * `PaymentRequest`, while preserving the full session under `rawPayload.acp`
 * for any mandate-aware ComplianceChecker downstream.
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
} from "@openagentpay/core";

export const PROTOCOL_ID = "acp-v0.1" as ProtocolId;
export const X_PAYMENT_ACP_HEADER = "X-PAYMENT-ACP";

/** Settlement rails ACP can ride. */
export type AcpRail = "stablecoin" | "card";

/** A money amount as it appears on the ACP wire (string-atomic, never float). */
export interface AcpAmount {
  readonly value: string;
  readonly currency: string;
  readonly decimals: number;
}

export interface AcpMerchant {
  readonly id: string;
  readonly name: string;
}

export interface AcpLineItem {
  readonly name: string;
  readonly quantity: number;
  readonly unitAmount: AcpAmount;
}

export interface AcpSettlement {
  readonly rail: AcpRail;
  readonly recipient?: string;
}

export interface Acp402Body {
  readonly acpVersion: string;
  readonly checkoutSessionId: string;
  readonly merchant: AcpMerchant;
  readonly lineItems: readonly AcpLineItem[];
  readonly total: AcpAmount;
  readonly settlement: AcpSettlement;
  /** Optional session expiry (Unix seconds). */
  readonly expiresAt?: number;
}

export interface AcpAdapterConfig {
  /** Restrict to a subset of rails (e.g. only ["stablecoin"]). */
  readonly preferredRails?: readonly AcpRail[];
  /** Allow-list of merchant ids. When set, others are rejected. */
  readonly trustedMerchants?: readonly string[];
  /**
   * When true (default), parse() verifies that `total` equals the sum of
   * `lineItems[].unitAmount * quantity`. Set false to trust the merchant total.
   */
  readonly verifyTotal?: boolean;
  /** Clock injection for deterministic expiry checks. */
  readonly now?: () => number;
}

export class AcpProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly preferredRails: ReadonlySet<AcpRail> | undefined;
  private readonly trustedMerchants: ReadonlySet<string> | undefined;
  private readonly verifyTotal: boolean;
  private readonly now: () => number;

  constructor(cfg: AcpAdapterConfig = {}) {
    this.preferredRails = cfg.preferredRails ? new Set(cfg.preferredRails) : undefined;
    this.trustedMerchants = cfg.trustedMerchants ? new Set(cfg.trustedMerchants) : undefined;
    this.verifyTotal = cfg.verifyTotal ?? true;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const v = body["acpVersion"];
    if (typeof v !== "string" || !v.startsWith("0.")) return false;
    if (typeof body["checkoutSessionId"] !== "string") return false;
    return Array.isArray(body["lineItems"]);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);

    if (this.preferredRails && !this.preferredRails.has(body.settlement.rail)) {
      throw new ProtocolError(
        `ACP rail '${body.settlement.rail}' not in preferred rails`,
        "unsupported_scheme"
      );
    }
    if (this.trustedMerchants && !this.trustedMerchants.has(body.merchant.id)) {
      throw new ProtocolError(
        `ACP merchant '${body.merchant.id}' not trusted`,
        "unsupported_scheme"
      );
    }
    if (body.expiresAt !== undefined && body.expiresAt * 1000 <= this.now()) {
      throw new ProtocolError(
        `ACP checkout session ${body.checkoutSessionId} expired`,
        "malformed"
      );
    }
    if (body.lineItems.length === 0) {
      throw new ProtocolError("ACP checkout session has no line items", "malformed");
    }
    if (this.verifyTotal) {
      this.assertTotalMatches(body);
    }

    const amount: Money = {
      amountAtomic: body.total.value,
      decimals: body.total.decimals,
      currency: body.total.currency,
    };
    const asset: Asset = { symbol: body.total.currency, decimals: body.total.decimals };
    const recipient = body.settlement.recipient ?? body.merchant.id;
    const validBefore =
      body.expiresAt ?? Math.floor(this.now() / 1000) + 600;
    const description = `ACP checkout ${body.checkoutSessionId} (${body.lineItems.length} item${
      body.lineItems.length === 1 ? "" : "s"
    })`;

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient,
      asset,
      validAfter: 0,
      validBefore,
      nonce: generateNonce(),
      rawPayload: { acp: body },
      description,
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("ACP retry requires signature", "missing_field");
    }
    const raw = signed.request.rawPayload;
    const acp = isObject(raw) ? raw["acp"] : undefined;
    const checkoutSessionId = isObject(acp) ? acp["checkoutSessionId"] : undefined;
    if (typeof checkoutSessionId !== "string") {
      throw new ProtocolError(
        "ACP retry requires checkoutSessionId in rawPayload.acp",
        "missing_field"
      );
    }
    const wire = {
      acpVersion: "0.1",
      checkoutSessionId,
      signer: signed.signer,
      signature: signed.signature,
      encoded: signed.encoded ?? null,
    };
    return {
      headers: {
        [X_PAYMENT_ACP_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // ── validation helpers ──────────────────────────────────────────────────

  private assertBody(body: unknown): Acp402Body {
    if (!isObject(body)) throw new ProtocolError("ACP body must be object", "malformed");

    const v = body["acpVersion"];
    if (typeof v !== "string") throw new ProtocolError("ACP missing acpVersion", "missing_field");
    if (!v.startsWith("0.")) {
      throw new ProtocolError(`ACP version ${v} not supported`, "unsupported_version");
    }
    if (typeof body["checkoutSessionId"] !== "string") {
      throw new ProtocolError("ACP missing checkoutSessionId", "missing_field");
    }

    const merchant = body["merchant"];
    if (!isObject(merchant)) throw new ProtocolError("ACP missing merchant block", "missing_field");
    if (typeof merchant["id"] !== "string") throw new ProtocolError("ACP merchant.id required", "missing_field");
    if (typeof merchant["name"] !== "string") throw new ProtocolError("ACP merchant.name required", "missing_field");

    const lineItems = body["lineItems"];
    if (!Array.isArray(lineItems)) throw new ProtocolError("ACP lineItems must be array", "missing_field");
    for (const [i, item] of lineItems.entries()) {
      if (!isObject(item)) throw new ProtocolError(`ACP lineItems[${i}] must be object`, "malformed");
      if (typeof item["name"] !== "string") throw new ProtocolError(`ACP lineItems[${i}].name required`, "missing_field");
      if (typeof item["quantity"] !== "number" || !Number.isInteger(item["quantity"]) || item["quantity"] <= 0) {
        throw new ProtocolError(`ACP lineItems[${i}].quantity must be positive integer`, "malformed");
      }
      assertAmount(item["unitAmount"], `lineItems[${i}].unitAmount`);
    }

    assertAmount(body["total"], "total");

    const settlement = body["settlement"];
    if (!isObject(settlement)) throw new ProtocolError("ACP missing settlement block", "missing_field");
    const rail = settlement["rail"];
    if (rail !== "stablecoin" && rail !== "card") {
      throw new ProtocolError("ACP settlement.rail must be 'stablecoin' | 'card'", "unsupported_scheme");
    }
    if (settlement["recipient"] !== undefined && typeof settlement["recipient"] !== "string") {
      throw new ProtocolError("ACP settlement.recipient must be string", "malformed");
    }

    const expiresAt = body["expiresAt"];
    if (expiresAt !== undefined && typeof expiresAt !== "number") {
      throw new ProtocolError("ACP expiresAt must be number (Unix seconds)", "malformed");
    }

    return body as unknown as Acp402Body;
  }

  /** Reject if total != sum(unitAmount * quantity). Operates in atomic bigint. */
  private assertTotalMatches(body: Acp402Body): void {
    const currency = body.total.currency;
    const decimals = body.total.decimals;
    let sum = 0n;
    for (const [i, item] of body.lineItems.entries()) {
      if (item.unitAmount.currency !== currency || item.unitAmount.decimals !== decimals) {
        throw new ProtocolError(
          `ACP lineItems[${i}] currency/decimals differ from total — cannot verify`,
          "malformed"
        );
      }
      sum += parseAtomic(item.unitAmount.value, `lineItems[${i}].unitAmount.value`) * BigInt(item.quantity);
    }
    const declared = parseAtomic(body.total.value, "total.value");
    if (sum !== declared) {
      throw new ProtocolError(
        `ACP total ${declared.toString()} != sum of line items ${sum.toString()}`,
        "malformed"
      );
    }
  }
}

// ── module-private utils ────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertAmount(v: unknown, label: string): asserts v is AcpAmount {
  if (!isObject(v)) throw new ProtocolError(`ACP ${label} must be object`, "missing_field");
  if (typeof v["value"] !== "string") throw new ProtocolError(`ACP ${label}.value must be string`, "missing_field");
  if (typeof v["currency"] !== "string") throw new ProtocolError(`ACP ${label}.currency required`, "missing_field");
  if (typeof v["decimals"] !== "number" || !Number.isInteger(v["decimals"]) || v["decimals"] < 0) {
    throw new ProtocolError(`ACP ${label}.decimals must be non-negative integer`, "malformed");
  }
}

function parseAtomic(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ProtocolError(`ACP ${label} must be an atomic integer string`, "malformed");
  }
  return BigInt(value);
}

function generateNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
