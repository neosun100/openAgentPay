/**
 * ConformanceCertificate — issuance, HMAC signing & verification
 * ===============================================================
 *
 * A {@link ConformanceCertificate} is a SIGNED, verifiable attestation that a
 * given wallet/protocol package passed the OpenAgentPay conformance suite. It is
 * the foundation for a FEDERATED certifier (oapconformance.io): third parties
 * run the suite against their own connector, issue a cert, sign it, and present
 * a verifiable badge that anyone can re-check.
 *
 * Signing MIRRORS the receipt HMAC approach in `@openagentpay/core`
 * (signReceiptHmac / verifyReceiptHmac):
 *
 *   issueCertificate       → build a cert, validate result.allPassed consistency
 *   signCertificateHmac    → attach an HMAC-SHA256 ProofValue over canonical JSON
 *   verifyCertificateHmac  → recompute + constant-time compare
 *
 * Canonical JSON recursively sorts object keys and omits the `signature` field
 * so the same logical cert always produces identical bytes.
 *
 * @license Apache-2.0
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CONFORMANCE_VERSION } from "@openagentpay/conformance";

// ============================================================================
//  Types
// ============================================================================

export type SubjectKind = "wallet" | "protocol";

/** Distilled, signable summary of a conformance run. */
export interface ConformanceResult {
  readonly passed: number;
  readonly skipped: number;
  readonly total: number;
  readonly allPassed: boolean;
}

/**
 * A linked-data-style proof value. Modelled on the receipt `ReceiptSignature`
 * shape so verifiers can treat OAP signatures uniformly.
 */
export interface ProofValue {
  readonly type: "HMAC-SHA256";
  readonly created: string;
  readonly verificationMethod: string;
  readonly proofValue: string;
}

export interface ConformanceCertificate {
  /** `urn:uuid:` identifier. */
  readonly id: string;
  /** Package being certified, e.g. `@openagentpay/wallet-foo`. */
  readonly subject: string;
  readonly subjectKind: SubjectKind;
  /** Conformance suite version this cert attests to (CONFORMANCE_VERSION). */
  readonly suiteVersion: string;
  readonly result: ConformanceResult;
  /** ISO 8601 issuance timestamp. */
  readonly issuedAt: string;
  /** Logical issuer identity (e.g. "oapconformance.io" or a self-cert label). */
  readonly issuer: string;
  /** Detached HMAC signature — present only after signCertificateHmac. */
  readonly signature?: ProofValue;
}

// ============================================================================
//  Errors
// ============================================================================

export class CertificateError extends Error {
  override readonly name = "CertificateError";
  constructor(
    message: string,
    public readonly code:
      | "result_inconsistent"
      | "empty_subject"
      | "missing_signature"
      | "internal"
  ) {
    super(message);
  }
}

// ============================================================================
//  issueCertificate
// ============================================================================

export interface IssueCertificateInput {
  readonly subject: string;
  readonly subjectKind: SubjectKind;
  readonly result: ConformanceResult;
  readonly issuer: string;
  /** Override suite version (defaults to CONFORMANCE_VERSION). Mostly tests. */
  readonly suiteVersion?: string;
  /** Override issuance time (defaults to Date.now). Mostly for tests. */
  readonly issuedAt?: string;
}

/**
 * Build a {@link ConformanceCertificate}, validating that `result.allPassed`
 * is consistent with the counts: a connector is "all passed" iff every test
 * either passed or was skipped (none failed) AND at least one actually ran.
 *
 *     allPassed === (passed + skipped === total && passed > 0)
 *
 * @throws {CertificateError} on empty subject or inconsistent result flag.
 */
export function issueCertificate(
  input: IssueCertificateInput
): ConformanceCertificate {
  if (input.subject.trim().length === 0) {
    throw new CertificateError(
      "certificate subject must be a non-empty package name",
      "empty_subject"
    );
  }

  const { passed, skipped, total, allPassed } = input.result;
  const expectedAllPassed = passed + skipped === total && passed > 0;
  if (allPassed !== expectedAllPassed) {
    throw new CertificateError(
      `result.allPassed=${allPassed} is inconsistent with passed=${passed} skipped=${skipped} total=${total} (expected ${expectedAllPassed})`,
      "result_inconsistent"
    );
  }

  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const certificate: ConformanceCertificate = {
    id: `urn:uuid:${randomUUID()}`,
    subject: input.subject,
    subjectKind: input.subjectKind,
    suiteVersion: input.suiteVersion ?? CONFORMANCE_VERSION,
    result: {
      passed,
      skipped,
      total,
      allPassed,
    },
    issuedAt,
    issuer: input.issuer,
  };
  return certificate;
}

// ============================================================================
//  Canonical serialization (stable key order, signature excluded)
// ============================================================================

/**
 * Deterministic JSON of a certificate with the `signature` field omitted —
 * object keys are recursively sorted so the same logical cert always produces
 * the same bytes regardless of construction order.
 */
export function canonicalCertificateJson(cert: ConformanceCertificate): string {
  const { signature: _signature, ...rest } = cert;
  void _signature;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`
  );
  return `{${parts.join(",")}}`;
}

// ============================================================================
//  HMAC sign / verify
// ============================================================================

const HMAC_VERIFICATION_METHOD = "openagentpay:certifier:hmac";

/**
 * Attach an `HMAC-SHA256` {@link ProofValue} over the canonical JSON. Returns
 * a NEW certificate — the input is not mutated.
 */
export function signCertificateHmac(
  cert: ConformanceCertificate,
  secret: string,
  options?: { readonly created?: string; readonly verificationMethod?: string }
): ConformanceCertificate {
  const proofValue = createHmac("sha256", secret)
    .update(canonicalCertificateJson(cert))
    .digest("hex");
  const signature: ProofValue = {
    type: "HMAC-SHA256",
    created: options?.created ?? new Date().toISOString(),
    verificationMethod: options?.verificationMethod ?? HMAC_VERIFICATION_METHOD,
    proofValue,
  };
  return { ...cert, signature };
}

/**
 * Verify an `HMAC-SHA256` certificate signature. Returns false if there is no
 * signature, the suite type is wrong, or the recomputed digest differs. Uses a
 * constant-time comparison to avoid timing side channels.
 */
export function verifyCertificateHmac(
  cert: ConformanceCertificate,
  secret: string
): boolean {
  const sig = cert.signature;
  if (!sig || sig.type !== "HMAC-SHA256") return false;
  const expected = createHmac("sha256", secret)
    .update(canonicalCertificateJson(cert))
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig.proofValue, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
