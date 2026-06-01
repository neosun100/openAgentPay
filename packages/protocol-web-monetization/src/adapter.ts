/**
 * @openagentpay/protocol-web-monetization — W3C Web Monetization
 * =============================================================================
 *
 * Web Monetization is a W3C draft (https://webmonetization.org/specification/)
 * in which a site declares a *payment pointer* — an Open Payments wallet
 * address URL — and the agent/browser streams micropayments toward it via the
 * Interledger STREAM protocol. The `$`-prefixed shorthand (e.g. `$wallet.example/alice`)
 * is the historical pointer syntax; it normalizes to an `https://` Open Payments
 * wallet-address URL (`$host/path` → `https://host/path`, bare `$host` → `https://host/.well-known/pay`).
 *
 * Relationship to `@openagentpay/protocol-open-payments`:
 *   Both are rooted in Interledger. **Web Monetization is the browser-streaming
 *   profile** — a thin "point at a wallet address and stream" surface intended
 *   for in-page monetization. **Open Payments is the full API** — the
 *   grant → quote → outgoing-payment flow with GNAP authorization. WM declares
 *   *where* to pay; Open Payments specifies *how* to negotiate and execute the
 *   payment. An agent often resolves a WM pointer and then drives the Open
 *   Payments API against that same wallet address.
 *
 * Wire format (v1, carried in a 402 body for the agent variant of WM):
 *   {
 *     "wmVersion": "1",
 *     "paymentPointer": "$wallet.example.com/alice" | "https://wallet.example.com/alice",
 *     "asset": { "code": "USD", "scale": 9 },
 *     "amount": { "value": "1000" },        // optional — atomic units at asset.scale
 *     "receiptsEnabled": true               // optional — STREAM receipts requested
 *   }
 *
 * @license Apache-2.0
 */

import {
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Money,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
  type ProtocolId,
  type SignedAuthorization,
} from "@openagentpay/core";

export const PROTOCOL_ID = "web-monetization-v1" as ProtocolId;
export const X_PAYMENT_WM_HEADER = "X-PAYMENT-WM";

export interface WmAsset {
  /** Asset code, e.g. "USD", "XRP", "USDC". */
  readonly code: string;
  /** Number of decimal places the asset is denominated in (Interledger "scale"). */
  readonly scale: number;
}

export interface Wm402Body {
  readonly wmVersion: "1";
  /** Open Payments wallet address URL (https://) or `$`-prefixed pointer shorthand. */
  readonly paymentPointer: string;
  readonly asset: WmAsset;
  /** Optional fixed amount (atomic units at asset.scale). Absent ⇒ open-ended stream. */
  readonly amount?: { readonly value: string };
  /** Optional: site requests STREAM receipts as proof-of-payment. */
  readonly receiptsEnabled?: boolean;
}

export interface WmAdapterConfig {
  /** Restrict to a set of trusted payment pointers (normalized https URLs or `$` form). */
  readonly trustedPointers?: readonly string[];
  /** Default amount (atomic, at asset.scale) used when the body omits `amount`. */
  readonly defaultStreamAmount?: string;
  /** Clock injection for deterministic validBefore in tests. */
  readonly now?: () => number;
}

export class WebMonetizationProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly trustedPointers: ReadonlySet<string> | undefined;
  private readonly defaultStreamAmount: string | undefined;
  private readonly now: () => number;

  constructor(cfg: WmAdapterConfig = {}) {
    this.trustedPointers = cfg.trustedPointers
      ? new Set(cfg.trustedPointers.map(normalizePointer))
      : undefined;
    this.defaultStreamAmount = cfg.defaultStreamAmount;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return body["wmVersion"] === "1" && typeof body["paymentPointer"] === "string";
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    const pointer = normalizePointer(body.paymentPointer);
    if (this.trustedPointers && !this.trustedPointers.has(pointer)) {
      throw new ProtocolError(
        `Web Monetization pointer '${pointer}' not in trusted set`,
        "unsupported_scheme"
      );
    }
    const value = body.amount?.value ?? this.defaultStreamAmount;
    if (typeof value !== "string" || value.length === 0) {
      throw new ProtocolError(
        "Web Monetization body has no amount and no defaultStreamAmount configured",
        "missing_field"
      );
    }
    const amount: Money = {
      amountAtomic: value,
      decimals: body.asset.scale,
      currency: body.asset.code,
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: pointer,
      asset: { symbol: body.asset.code, decimals: body.asset.scale },
      validAfter: 0,
      validBefore,
      nonce: generateNonce(),
      rawPayload: { webMonetization: body },
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("Web Monetization retry requires signature", "missing_field");
    }
    const wire = {
      wmVersion: "1",
      paymentPointer: signed.request.recipient,
      signer: signed.signer,
      signature: signed.signature,
      encoded: signed.encoded ?? null,
    };
    return {
      headers: {
        [X_PAYMENT_WM_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): Wm402Body {
    if (!isObject(body)) throw new ProtocolError("WM body must be object", "malformed");
    if (body["wmVersion"] !== "1") {
      throw new ProtocolError(
        `WM version ${String(body["wmVersion"])} not supported`,
        "unsupported_version"
      );
    }
    const pointer = body["paymentPointer"];
    if (typeof pointer !== "string" || pointer.trim().length === 0) {
      throw new ProtocolError("WM paymentPointer required", "missing_field");
    }
    if (!isValidPointer(pointer)) {
      throw new ProtocolError(
        `WM paymentPointer '${pointer}' must be https:// or start with $`,
        "malformed"
      );
    }
    const asset = body["asset"];
    if (!isObject(asset)) throw new ProtocolError("WM missing asset block", "missing_field");
    if (typeof asset["code"] !== "string") {
      throw new ProtocolError("WM asset.code required", "missing_field");
    }
    if (typeof asset["scale"] !== "number" || !Number.isInteger(asset["scale"]) || asset["scale"] < 0) {
      throw new ProtocolError("WM asset.scale must be a non-negative integer", "malformed");
    }
    return body as unknown as Wm402Body;
  }
}

function isValidPointer(p: string): boolean {
  return p.startsWith("https://") || p.startsWith("$");
}

/**
 * Normalize a payment pointer to its canonical `https://` Open Payments
 * wallet-address URL:
 *   `$host/path` → `https://host/path`
 *   `$host`      → `https://host/.well-known/pay`
 *   `https://…`  → unchanged
 */
function normalizePointer(p: string): string {
  const trimmed = p.trim();
  if (trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("$")) {
    const rest = trimmed.slice(1);
    const slash = rest.indexOf("/");
    if (slash === -1) return `https://${rest}/.well-known/pay`;
    return `https://${rest}`;
  }
  return trimmed;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function generateNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
