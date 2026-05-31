/**
 * RealBybitSigner — Bybit Pay HMAC-SHA256 credential & signing primitive.
 * ======================================================================
 *
 * Bybit's V5 REST API authenticates requests with an HMAC-SHA256 signature
 * over a canonical preimage:
 *
 *     preimage  = `${timestamp}${apiKey}${recvWindow}${payload}`
 *     signature = HMAC_SHA256(apiSecret, preimage).hex   // lowercase hex
 *
 * (Ref: https://bybit-exchange.github.io/docs/v5/guide#authentication)
 *
 * This signer is the lowest crypto layer for the Bybit Pay connector. It is
 * fully offline & deterministic:
 *
 *   - generateBybitKeypair()       — mint a mock {apiKey, apiSecret} credential
 *                                     pair + a mock Bybit account id, IN-PROCESS,
 *                                     no signups / no network. Address format
 *                                     matches Bybit's real handle shape.
 *   - keypairFromSecret()          — deterministically derive the same credential
 *                                     pair from a stable seed string.
 *   - sign() / verify()            — real, verifiable HMAC-SHA256 over the
 *                                     canonical OAP-CEX authorization preimage.
 *
 * @license Apache-2.0
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ============================================================================
//  Credential pair (Bybit "API key")
// ============================================================================

export interface BybitCredential {
  /** Bybit API key — 18-char alphanumeric token (matches real Bybit key shape). */
  readonly apiKey: string;
  /** Bybit API secret — 36-char alphanumeric token. NEVER logged. */
  readonly apiSecret: string;
  /**
   * Mock Bybit account id (the `publicHandle`). Real Bybit member ids are
   * numeric; we emit a `bybit-` prefixed numeric handle so it is recognisable
   * yet collision-free across tests.
   */
  readonly accountId: string;
}

const KEY_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Map raw bytes onto Bybit's alphanumeric key alphabet (deterministic). */
function bytesToToken(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    // non-null: i is bounded by length, bytes is at least `length` long
    const b = bytes[i % bytes.length]!;
    out += KEY_ALPHABET[b % KEY_ALPHABET.length];
  }
  return out;
}

/**
 * Derive a deterministic numeric Bybit account id from the apiKey. Real Bybit
 * member ids look like "1234567890" — we hash the apiKey into a 10-digit id so
 * the same credential always maps to the same handle (needed for idempotency).
 */
function deriveAccountId(apiKey: string): string {
  const h = createHmac("sha256", "bybit-member-id-v1").update(apiKey).digest();
  // Take 5 bytes → up to ~1.1e12, then mod to a stable 10-digit space.
  const n =
    ((BigInt(h[0]!) << 32n) |
      (BigInt(h[1]!) << 24n) |
      (BigInt(h[2]!) << 16n) |
      (BigInt(h[3]!) << 8n) |
      BigInt(h[4]!)) %
    10_000_000_000n;
  return `bybit-${n.toString().padStart(10, "0")}`;
}

// ============================================================================
//  Key generation
// ============================================================================

/**
 * Generate a fresh mock Bybit credential pair IN-PROCESS. No signups, no
 * network. The shapes mirror real Bybit API credentials (18-char key,
 * 36-char secret, numeric member id).
 */
export function generateBybitKeypair(): BybitCredential {
  const apiKey = bytesToToken(randomBytes(18), 18);
  const apiSecret = bytesToToken(randomBytes(36), 36);
  return {
    apiKey,
    apiSecret,
    accountId: deriveAccountId(apiKey),
  };
}

/**
 * Deterministically derive a Bybit credential pair from a stable seed string.
 * Same seed ⇒ same {apiKey, apiSecret, accountId}. Used by the conformance
 * suite so runs are reproducible.
 */
export function keypairFromSecret(seed: string): BybitCredential {
  const keyMaterial = createHmac("sha256", "bybit-apikey-v1").update(seed).digest();
  const secretMaterial = createHmac("sha256", "bybit-apisecret-v1")
    .update(seed)
    .digest();
  const apiKey = bytesToToken(keyMaterial, 18);
  const apiSecret = bytesToToken(secretMaterial, 36);
  return {
    apiKey,
    apiSecret,
    accountId: deriveAccountId(apiKey),
  };
}

// ============================================================================
//  Canonical preimage
// ============================================================================

export interface BybitSignParams {
  /** Millisecond request timestamp (string). */
  readonly timestamp: string;
  /** API key (Bybit "X-BAPI-API-KEY"). */
  readonly apiKey: string;
  /** Receive-window in ms (Bybit "X-BAPI-RECV-WINDOW"), default "5000". */
  readonly recvWindow: string;
  /** Canonical request payload (JSON for POST, query string for GET). */
  readonly payload: string;
}

/**
 * Build the exact preimage Bybit V5 signs:
 *   `${timestamp}${apiKey}${recvWindow}${payload}`
 */
export function buildPreimage(p: BybitSignParams): string {
  return `${p.timestamp}${p.apiKey}${p.recvWindow}${p.payload}`;
}

// ============================================================================
//  Signer
// ============================================================================

export interface RealBybitSignerConfig {
  /** The credential pair this signer is bound to. */
  readonly credential: BybitCredential;
}

export class RealBybitSigner {
  private readonly credential: BybitCredential;

  constructor(config: RealBybitSignerConfig) {
    this.credential = config.credential;
  }

  /** The bound credential's public account id (publicHandle). */
  get accountId(): string {
    return this.credential.accountId;
  }

  /** The bound credential's API key. */
  get apiKey(): string {
    return this.credential.apiKey;
  }

  /**
   * Produce a REAL HMAC-SHA256 signature (lowercase hex) over the Bybit V5
   * canonical preimage. Verifiable via {@link verify}.
   */
  sign(params: BybitSignParams): string {
    const preimage = buildPreimage(params);
    return createHmac("sha256", this.credential.apiSecret)
      .update(preimage)
      .digest("hex");
  }

  /**
   * Verify a signature against a preimage using a constant-time compare.
   * Returns false on any length/format mismatch (no throw).
   */
  verify(params: BybitSignParams, signature: string): boolean {
    return RealBybitSigner.verify(this.credential.apiSecret, params, signature);
  }

  /**
   * Static verifier — useful for cross-checking with only the apiSecret in hand
   * (e.g., a merchant validating an inbound OAP-CEX token).
   */
  static verify(
    apiSecret: string,
    params: BybitSignParams,
    signature: string
  ): boolean {
    const expected = createHmac("sha256", apiSecret)
      .update(buildPreimage(params))
      .digest("hex");
    if (
      typeof signature !== "string" ||
      signature.length !== expected.length
    ) {
      return false;
    }
    try {
      return timingSafeEqual(
        Buffer.from(expected, "utf8"),
        Buffer.from(signature, "utf8")
      );
    } catch {
      return false;
    }
  }
}
