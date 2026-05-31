/**
 * RealBitgetSigner
 * ================
 *
 * Bitget Wallet Pay is a CEX-style provider: instead of an on-chain private
 * key, the merchant authenticates with an `apiKey` / `apiSecret` pair and signs
 * each authorization with **HMAC-SHA256** over a canonical payload — mirroring
 * Bitget's real `ACCESS-SIGN` scheme.
 *
 * This module is fully offline-safe:
 *   - `generateBitgetKeypair()` mints a fresh mock merchant credential set
 *     IN-PROCESS (no signups, no network) using `node:crypto` randomness.
 *   - `sign()` produces a REAL, verifiable HMAC-SHA256 signature.
 *   - `verify()` lets tests prove the signature round-trips and that a tampered
 *     message fails.
 *   - On-chain / CEX-backend broadcast is deferred behind an optional pluggable
 *     `submit` hook. With no hook, settlement returns a deterministic mock tx
 *     ref so the suite runs without any network.
 *
 * ⚠️ NEVER log or persist `apiSecret`.
 *
 * @license Apache-2.0
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ============================================================================
//  Credential (the Bitget "keypair" analog)
// ============================================================================

/**
 * A Bitget Pay merchant credential. `merchantId` is the public handle that
 * appears as the payer/recipient identity; `apiKey` selects the credential
 * server-side; `apiSecret` is the HMAC key (NEVER logged).
 */
export interface BitgetCredential {
  /** Public Bitget merchant id (e.g., "bg_merchant_ab12cd34"). */
  readonly merchantId: string;
  /** Public API key id. */
  readonly apiKey: string;
  /** HMAC-SHA256 secret. Treat as sensitive. */
  readonly apiSecret: string;
}

/** Bitget HMAC algorithm label used in the wire token. */
export const BITGET_SIG_ALG = "HMAC-SHA256" as const;

// ============================================================================
//  Keypair generation + loaders (offline, in-process)
// ============================================================================

/**
 * Mint a fresh mock Bitget merchant credential set IN-PROCESS.
 *
 * Format mirrors Bitget's real id shapes closely enough to be realistic while
 * being unmistakably a test credential:
 *   - merchantId: "bg_merchant_" + 8 lowercase-hex
 *   - apiKey:     "bg_" + 24 lowercase-hex
 *   - apiSecret:  64 lowercase-hex (256 bits of entropy)
 */
export function generateBitgetKeypair(): BitgetCredential {
  const merchantId = `bg_merchant_${randomBytes(4).toString("hex")}`;
  const apiKey = `bg_${randomBytes(12).toString("hex")}`;
  const apiSecret = randomBytes(32).toString("hex");
  return { merchantId, apiKey, apiSecret };
}

/**
 * Build a credential from explicit parts (e.g., loaded from Secrets Manager).
 * `merchantId` defaults to a deterministic value derived from the apiKey so the
 * public handle is stable across restarts.
 */
export function keypairFromParts(input: {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly merchantId?: string;
}): BitgetCredential {
  if (!input.apiKey) throw new Error("apiKey is required");
  if (!input.apiSecret) throw new Error("apiSecret is required");
  const merchantId =
    input.merchantId ??
    `bg_merchant_${createHmac("sha256", "bitget-merchant").update(input.apiKey).digest("hex").slice(0, 8)}`;
  return { merchantId, apiKey: input.apiKey, apiSecret: input.apiSecret };
}

/**
 * Deterministically derive a credential from a single seed string. Useful for
 * reproducible conformance fixtures.
 */
export function keypairFromSeed(seed: string): BitgetCredential {
  const apiKey = `bg_${createHmac("sha256", "bitget-apikey").update(seed).digest("hex").slice(0, 24)}`;
  const apiSecret = createHmac("sha256", "bitget-apisecret").update(seed).digest("hex");
  return keypairFromParts({ apiKey, apiSecret });
}

// ============================================================================
//  Canonical payload + signing
// ============================================================================

/**
 * Canonical authorization payload. The exact byte sequence that gets HMAC'd —
 * deterministic field order so sign()/verify() are reproducible.
 */
export interface BitgetAuthPayload {
  readonly asset: string;
  readonly amount: string;
  readonly amountDecimals: number;
  readonly from: string;
  readonly to: string;
  readonly nonce: string;
  readonly validBefore: number;
  readonly signedAt: number;
}

/**
 * Produce the canonical string that is HMAC'd. Bitget's real scheme is
 * `timestamp + method + requestPath + body`; we emulate it with a stable,
 * newline-joined canonical form over the authorization fields.
 */
export function canonicalize(p: BitgetAuthPayload): string {
  // Field order is fixed and must never change without a version bump.
  return [
    `asset=${p.asset}`,
    `amount=${p.amount}`,
    `amountDecimals=${p.amountDecimals}`,
    `from=${p.from}`,
    `to=${p.to}`,
    `nonce=${p.nonce}`,
    `validBefore=${p.validBefore}`,
    `signedAt=${p.signedAt}`,
  ].join("\n");
}

/** Compute the HMAC-SHA256 signature (hex, upper-case) for a payload. */
export function hmacSign(secret: string, payload: BitgetAuthPayload): string {
  return createHmac("sha256", secret)
    .update(canonicalize(payload))
    .digest("hex")
    .toUpperCase();
}

/**
 * Constant-time verification that `signature` matches `payload` under `secret`.
 * Returns false on any length/format mismatch rather than throwing.
 */
export function hmacVerify(
  secret: string,
  payload: BitgetAuthPayload,
  signature: string
): boolean {
  const expected = hmacSign(secret, payload);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8")
    );
  } catch {
    return false;
  }
}

// ============================================================================
//  Submit hook (pluggable broadcast)
// ============================================================================

/** Result returned by a `submit` hook implementation. */
export interface BitgetSubmitResult {
  readonly transactionRef: string;
  readonly network?: string;
  readonly raw?: unknown;
}

/**
 * Optional broadcast hook. When provided, {@link RealBitgetSigner.settle}
 * delegates to it (e.g., a real Bitget `/pay/order` POST). When omitted, a
 * deterministic offline mock ref is returned so tests never touch the network.
 */
export type BitgetSubmitHook = (args: {
  readonly payload: BitgetAuthPayload;
  readonly signature: string;
  readonly credential: BitgetCredential;
}) => Promise<BitgetSubmitResult>;

// ============================================================================
//  Signer
// ============================================================================

export interface RealBitgetSignerConfig {
  /** Merchant credential. If omitted, a fresh one is minted in-process. */
  readonly credential?: BitgetCredential;
  /** Optional deterministic seed → credential (overridden by `credential`). */
  readonly seed?: string;
  /** Optional broadcast hook; default is offline mock. */
  readonly submit?: BitgetSubmitHook;
  /** Sandbox flag — surfaced in network labels for telemetry. */
  readonly sandbox?: boolean;
}

export class RealBitgetSigner {
  readonly credential: BitgetCredential;
  readonly sandbox: boolean;
  private readonly submitHook: BitgetSubmitHook | undefined;

  constructor(config: RealBitgetSignerConfig = {}) {
    this.credential =
      config.credential ??
      (config.seed !== undefined
        ? keypairFromSeed(config.seed)
        : generateBitgetKeypair());
    this.submitHook = config.submit;
    this.sandbox = config.sandbox ?? true;
  }

  /** Public merchant id (the instrument's publicHandle). */
  get merchantId(): string {
    return this.credential.merchantId;
  }

  /** Network label (sandbox vs prod). */
  get network(): string {
    return this.sandbox ? "bitget-pay-sandbox" : "bitget-pay";
  }

  /** Sign an authorization payload → HMAC-SHA256 hex signature. */
  sign(payload: BitgetAuthPayload): string {
    return hmacSign(this.credential.apiSecret, payload);
  }

  /** Verify a signature against this signer's secret. */
  verify(payload: BitgetAuthPayload, signature: string): boolean {
    return hmacVerify(this.credential.apiSecret, payload, signature);
  }

  /**
   * Broadcast. Uses the pluggable hook when present; otherwise returns a
   * deterministic offline mock transaction ref derived from the signature so
   * the result is reproducible without any network.
   */
  async settle(
    payload: BitgetAuthPayload,
    signature: string
  ): Promise<BitgetSubmitResult> {
    if (this.submitHook) {
      return this.submitHook({
        payload,
        signature,
        credential: this.credential,
      });
    }
    // Offline-safe deterministic ref: stable across runs for the same inputs.
    const ref = createHmac("sha256", "bitget-mock-tx")
      .update(`${payload.nonce}:${signature}`)
      .digest("hex")
      .slice(0, 32);
    return {
      transactionRef: `bgpay_${ref}`,
      network: this.network,
      raw: { mock: true, offline: true },
    };
  }
}
