/**
 * @openagentpay/protocol-gnap — GNAP payment-authorization profile
 * =========================================================================
 *
 * GNAP (Grant Negotiation and Authorization Protocol, RFC 9635) is the IETF
 * successor to OAuth 2.0. A client requests access by *describing the access
 * it wants*; the Authorization Server (AS) responds with a grant containing
 * access tokens and (optionally) interaction references.
 *
 * Here we map GNAP's grant-request/response shape onto a payment-authorization
 * challenge: a 402 carries a GNAP grant describing a `payment`-type access
 * right (amount + actions + recipient). The agent's signed authorization is
 * carried back as a GNAP grant continuation in `X-PAYMENT-GNAP`.
 *
 *   ⚠️ GNAP is an AUTHORIZATION layer (like AP2 mandates) — NOT a settlement
 *   rail. It says "this client is authorized to move N USDC to recipient R",
 *   but does not itself move funds. It therefore COMPOSES with any settlement
 *   protocol (x402, MPP, OAP-CEX, Solana Pay, ...): the GNAP grant authorizes,
 *   the settlement adapter executes.
 *
 * Wire format (v1):
 *   {
 *     "gnapVersion": "1",
 *     "grantEndpoint": "https://as.example/grant",
 *     "accessToken": { "value": "...", "manage": "https://as.example/token/..." },
 *     "access": [
 *       {
 *         "type": "payment",
 *         "actions": ["pay", "refund"],
 *         "amount": { "value": "1000", "currency": "USDC", "decimals": 6 },
 *         "recipient": "0x..."
 *       }
 *     ],
 *     "interact": { "redirect": "https://as.example/interact/..." }
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

export const PROTOCOL_ID = "gnap-v1" as ProtocolId;
export const X_PAYMENT_GNAP_HEADER = "X-PAYMENT-GNAP";

/** GNAP version we speak. */
export const GNAP_VERSION = "1" as const;

/** A single access right inside a GNAP grant. We only act on `payment`. */
export interface GnapAccess {
  readonly type: string;
  readonly actions: readonly string[];
  readonly amount: { readonly value: string; readonly currency: string; readonly decimals: number };
  readonly recipient?: string;
}

/** GNAP access token, returned by the AS once a grant is approved. */
export interface GnapAccessToken {
  readonly value?: string;
  readonly manage?: string;
}

/** GNAP interaction references — how the client continues an in-progress grant. */
export interface GnapInteract {
  readonly redirect?: string;
}

export interface Gnap402Body {
  readonly gnapVersion: string;
  readonly grantEndpoint: string;
  readonly accessToken?: GnapAccessToken;
  readonly access: readonly GnapAccess[];
  readonly interact?: GnapInteract;
}

export interface GnapAdapterConfig {
  /** Optionally restrict which GNAP `actions` are acceptable (e.g. only "pay"). */
  readonly allowedActions?: readonly string[];
  /** Optionally pin trusted grant endpoints (exact-match). */
  readonly trustedGrantEndpoints?: readonly string[];
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

export class GnapProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly allowedActions: ReadonlySet<string> | undefined;
  private readonly trustedGrantEndpoints: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(cfg: GnapAdapterConfig = {}) {
    this.allowedActions = cfg.allowedActions ? new Set(cfg.allowedActions) : undefined;
    this.trustedGrantEndpoints = cfg.trustedGrantEndpoints
      ? new Set(cfg.trustedGrantEndpoints)
      : undefined;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    if (typeof body["gnapVersion"] !== "string") return false;
    if (typeof body["grantEndpoint"] !== "string") return false;
    const access = body["access"];
    if (!Array.isArray(access)) return false;
    return access.some((a) => isObject(a) && a["type"] === "payment");
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);

    if (this.trustedGrantEndpoints && !this.trustedGrantEndpoints.has(body.grantEndpoint)) {
      throw new ProtocolError(
        `GNAP grantEndpoint '${body.grantEndpoint}' not trusted`,
        "unsupported_scheme"
      );
    }

    const payment = body.access.find((a) => a.type === "payment");
    if (!payment) {
      throw new ProtocolError("GNAP grant has no payment-type access entry", "missing_field");
    }

    if (this.allowedActions && !payment.actions.some((a) => this.allowedActions!.has(a))) {
      throw new ProtocolError(
        `GNAP access actions [${payment.actions.join(", ")}] not in allowed actions`,
        "unsupported_scheme"
      );
    }

    const amount: Money = {
      amountAtomic: payment.amount.value,
      decimals: payment.amount.decimals,
      currency: payment.amount.currency,
    };
    const recipient = payment.recipient ?? body.grantEndpoint;
    const validBefore = Math.floor(this.now() / 1000) + 600;

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient,
      asset: { symbol: payment.amount.currency, decimals: payment.amount.decimals },
      validAfter: 0,
      validBefore,
      nonce: generateNonce(),
      rawPayload: { gnap: body },
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("GNAP retry requires signature", "missing_field");
    }
    const rawAccessToken =
      isObject(signed.request.rawPayload) && isObject(signed.request.rawPayload["gnap"])
        ? (signed.request.rawPayload["gnap"] as Record<string, unknown>)["accessToken"]
        : undefined;
    const accessTokenValue =
      isObject(rawAccessToken) && typeof rawAccessToken["value"] === "string"
        ? rawAccessToken["value"]
        : undefined;
    // GNAP grant continuation: carry the AS-issued access token (if any) plus
    // the agent's signed payment authorization back to the merchant endpoint.
    const wire = {
      gnapVersion: GNAP_VERSION,
      signer: signed.signer,
      signature: signed.signature,
      accessToken: accessTokenValue ?? null,
      encoded: signed.encoded ?? null,
    };
    return {
      headers: {
        [X_PAYMENT_GNAP_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): Gnap402Body {
    if (!isObject(body)) throw new ProtocolError("GNAP body must be object", "malformed");
    const v = body["gnapVersion"];
    if (typeof v !== "string") throw new ProtocolError("GNAP missing gnapVersion", "missing_field");
    if (v !== GNAP_VERSION) {
      throw new ProtocolError(`GNAP version ${v} not supported`, "unsupported_version");
    }
    if (typeof body["grantEndpoint"] !== "string") {
      throw new ProtocolError("GNAP missing grantEndpoint", "missing_field");
    }
    const access = body["access"];
    if (!Array.isArray(access)) {
      throw new ProtocolError("GNAP access must be array", "missing_field");
    }
    if (access.length === 0) {
      throw new ProtocolError("GNAP access[] must be non-empty", "missing_field");
    }
    for (const entry of access) {
      if (!isObject(entry)) throw new ProtocolError("GNAP access entry must be object", "malformed");
      if (typeof entry["type"] !== "string") {
        throw new ProtocolError("GNAP access.type required", "missing_field");
      }
      if (!Array.isArray(entry["actions"])) {
        throw new ProtocolError("GNAP access.actions must be array", "missing_field");
      }
      if (!isObject(entry["amount"])) {
        throw new ProtocolError("GNAP access.amount required", "missing_field");
      }
      const amt = entry["amount"] as Record<string, unknown>;
      if (typeof amt["value"] !== "string") {
        throw new ProtocolError("GNAP access.amount.value must be string", "missing_field");
      }
      if (typeof amt["currency"] !== "string") {
        throw new ProtocolError("GNAP access.amount.currency required", "missing_field");
      }
      if (typeof amt["decimals"] !== "number") {
        throw new ProtocolError("GNAP access.amount.decimals must be number", "missing_field");
      }
    }
    return body as unknown as Gnap402Body;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function generateNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
