/**
 * RealOkxSigner
 * =============
 *
 * The low-level credential + HMAC layer for OKX Pay. Knows nothing about
 * OpenAgentPay types — it only knows how to:
 *
 *   1. Hold a 3-piece OKX-style credential (apiKey / apiSecret / passphrase).
 *   2. Compute a canonical OAP-CEX payload digest.
 *   3. Produce a REAL HMAC-SHA256 signature (base64) — exactly the OKX
 *      `OK-ACCESS-SIGN` recipe: `HMAC_SHA256(secret, prehash).base64`.
 *   4. Verify a signature against the secret (constant-time compare).
 *
 * OKX signs `${timestamp}${method}${requestPath}${body}` with the API secret
 * and base64-encodes it. We mirror that: the "prehash" string is the canonical
 * OAP-CEX authorization JSON, and the digest is base64.
 *
 * Offline-safe: signing is pure in-process crypto. On-chain / CEX broadcast is
 * deferred to an optional `submit` hook on the connector (defaults to a
 * deterministic mock receipt id).
 *
 * ⚠️ NEVER log or persist `apiSecret` / `passphrase`.
 *
 * @license Apache-2.0
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ============================================================================
//  Credential
// ============================================================================

/** OKX-style 3-piece API credential. */
export interface OkxCredential {
  /** Public API key (the `OK-ACCESS-KEY`). Safe to surface. */
  readonly apiKey: string;
  /** Secret used to HMAC-sign requests. NEVER logged. */
  readonly apiSecret: string;
  /** Passphrase chosen at key-creation time (the `OK-ACCESS-PASSPHRASE`). */
  readonly passphrase: string;
  /** Sub-account id this credential operates under — the public handle. */
  readonly subAccountId: string;
}

/** HMAC algorithm tag carried on the wire (matches OapCexWireToken). */
export const OKX_SIGN_ALG = "HMAC-SHA256" as const;

// ============================================================================
//  Keypair / credential generation (in-process, no network, no signups)
// ============================================================================

/**
 * Generate a fresh mock OKX credential in-process. Produces values shaped like
 * real OKX credentials:
 *   - apiKey      → UUID v4 (OKX api keys are UUIDs)
 *   - apiSecret   → 32-byte hex (OKX secrets are 32-hex-char-ish; we use 64 hex)
 *   - passphrase  → 16-char alphanumeric
 *   - subAccountId→ `oap-sub-<8hex>` (OKX sub-account ids are user-chosen labels)
 *
 * No signups, no I/O. Deterministic when a `seed` is supplied.
 */
export function generateOkxCredential(seed?: Uint8Array): OkxCredential {
  // Counter is LOCAL to this call so the same seed is fully deterministic
  // across invocations (each piece gets a distinct, reproducible derivation).
  let counter = 0;
  const rnd = (n: number): Buffer =>
    seed ? deriveBytes(seed, n, counter++) : randomBytes(n);

  const apiKey = formatUuidV4(rnd(16));
  const apiSecret = rnd(32).toString("hex");
  const passphrase = base62(rnd(12)).slice(0, 16);
  const subAccountId = `oap-sub-${rnd(4).toString("hex")}`;

  return { apiKey, apiSecret, passphrase, subAccountId };
}

/** Deterministic byte derivation from a seed (HMAC-DRBG-lite, test-only). */
function deriveBytes(seed: Uint8Array, n: number, counter: number): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (Buffer.concat(out).length < n) {
    const block = createHmac("sha256", Buffer.from(seed))
      .update(`oap-okx-${counter}-${i}`)
      .digest();
    out.push(block);
    i++;
  }
  return Buffer.concat(out).subarray(0, n);
}

function formatUuidV4(b: Buffer): string {
  const h = b.toString("hex").padEnd(32, "0").slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

function base62(b: Buffer): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (const byte of b) out += alphabet[byte % 62]!;
  return out;
}

/**
 * Load a credential from explicit pieces (e.g. from a secret manager).
 * Validates all four pieces are present + non-empty.
 */
export function keypairFromCredential(input: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  subAccountId: string;
}): OkxCredential {
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`OKX credential field "${k}" is required and must be non-empty`);
    }
  }
  return {
    apiKey: input.apiKey,
    apiSecret: input.apiSecret,
    passphrase: input.passphrase,
    subAccountId: input.subAccountId,
  };
}

// ============================================================================
//  Canonical authorization payload (deterministic for HMAC)
// ============================================================================

export interface OkxAuthorizationPayload {
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
 * Build OKX's prehash string. Mirrors OKX `OK-ACCESS-SIGN` prehash
 * (`timestamp + method + requestPath + body`), but the "body" is the canonical
 * OAP-CEX authorization JSON and the request path is a stable virtual route.
 */
export function buildPrehash(payload: OkxAuthorizationPayload): string {
  const isoTs = new Date(payload.signedAt * 1000).toISOString();
  const body = JSON.stringify(payload);
  return `${isoTs}POST/oap-cex/v1/authorize${body}`;
}

// ============================================================================
//  Signer
// ============================================================================

export interface RealOkxSignerConfig {
  /** Full credential. Either pass this OR a `seed` to auto-generate. */
  readonly credential?: OkxCredential;
  /** Deterministic seed used to generate a credential if none supplied. */
  readonly seed?: Uint8Array;
}

export class RealOkxSigner {
  readonly credential: OkxCredential;

  constructor(config: RealOkxSignerConfig = {}) {
    this.credential =
      config.credential ?? generateOkxCredential(config.seed);
  }

  /** Public sub-account id — the connector's publicHandle / signer. */
  get subAccountId(): string {
    return this.credential.subAccountId;
  }

  /** Public API key — safe to surface for telemetry. */
  get apiKey(): string {
    return this.credential.apiKey;
  }

  /**
   * Produce a REAL HMAC-SHA256 signature over the canonical payload.
   * Output is base64 (OKX `OK-ACCESS-SIGN` format).
   */
  sign(payload: OkxAuthorizationPayload): string {
    const prehash = buildPrehash(payload);
    return createHmac("sha256", this.credential.apiSecret)
      .update(prehash)
      .digest("base64");
  }

  /**
   * Verify a signature against this signer's secret. Constant-time.
   * Returns false on length mismatch or tampered payload.
   */
  verify(payload: OkxAuthorizationPayload, signature: string): boolean {
    return verifyOkxSignature(this.credential.apiSecret, payload, signature);
  }
}

/**
 * Stateless verifier — recomputes the HMAC and compares constant-time.
 * Exposed so merchant-side validators can verify without a signer instance.
 */
export function verifyOkxSignature(
  apiSecret: string,
  payload: OkxAuthorizationPayload,
  signature: string
): boolean {
  const expected = createHmac("sha256", apiSecret)
    .update(buildPrehash(payload))
    .digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
