/**
 * demo-thirdparty — canonical "how a third party integrates" example
 * ==================================================================
 *
 * This is the reference flow a downstream repo follows to self-certify a
 * wallet/protocol connector against the OpenAgentPay conformance suite:
 *
 *   1. Run the conformance suite → obtain a {@link ConformanceReport}.
 *   2. Distill it into a signable {@link ConformanceResult} (resultFromReport).
 *   3. issueCertificate — derives & validates allPassed, throws if it didn't.
 *   4. signCertificateHmac — attach a detached HMAC-SHA256 proof.
 *   5. Store it in a {@link CertificateRegistry} (here, in-memory).
 *   6. Re-read from the registry and verifyCertificateHmac — proving the
 *      stored cert round-trips and the signature still checks out.
 *
 * The returned shape is deliberately small so a CI step / external repo can
 * assert on it directly.
 *
 * @license Apache-2.0
 */

import type { ConformanceReport } from "@openagentpay/conformance";
import {
  type ConformanceCertificate,
  type SubjectKind,
  CertificateError,
  issueCertificate,
  signCertificateHmac,
  verifyCertificateHmac,
} from "./certificate.js";
import { resultFromReport } from "./report.js";
import { InMemoryCertificateRegistry } from "./registry.js";

export interface ThirdPartyCertificationInput {
  /** Package being certified, e.g. `@openagentpay/wallet-foo`. */
  readonly subject: string;
  readonly subjectKind: SubjectKind;
  /** HMAC secret used to sign (and re-verify) the certificate. */
  readonly secret: string;
  /** Logical issuer identity. Defaults to a self-cert label. */
  readonly issuer?: string;
  /**
   * If provided, this registry is used (and mutated) instead of a fresh
   * in-memory one — handy for accumulating multiple certs across subjects.
   */
  readonly registry?: InMemoryCertificateRegistry;
}

export interface ThirdPartyCertificationResult {
  /** The signed certificate as stored in the registry. */
  readonly certificate: ConformanceCertificate;
  /** True iff the re-read-from-registry cert verifies against `secret`. */
  readonly verified: boolean;
  /** Number of entries in the registry after storing this cert. */
  readonly registrySize: number;
}

/**
 * Issue → sign → store → re-read → verify, end to end.
 *
 * @throws {CertificateError} if the report is not all-passed (a third party
 *   may not self-certify a failing connector) or the subject is empty.
 */
export function runThirdPartyCertification(
  report: ConformanceReport,
  input: ThirdPartyCertificationInput
): ThirdPartyCertificationResult {
  const result = resultFromReport(report);

  if (!result.allPassed) {
    throw new CertificateError(
      `cannot certify ${input.subject}: conformance run was not all-passed ` +
        `(passed=${result.passed} skipped=${result.skipped} total=${result.total})`,
      "result_inconsistent"
    );
  }

  const issued = issueCertificate({
    subject: input.subject,
    subjectKind: input.subjectKind,
    result,
    issuer: input.issuer ?? "self-cert:third-party",
  });

  const signed = signCertificateHmac(issued, input.secret);

  const registry = input.registry ?? new InMemoryCertificateRegistry();
  registry.issue(signed);

  // Re-read from the registry rather than trusting the in-memory object, so
  // this exercises the full store → fetch → verify round-trip.
  const stored = registry.get(signed.id);
  const verified =
    stored !== undefined && verifyCertificateHmac(stored.certificate, input.secret);

  return {
    certificate: signed,
    verified,
    registrySize: registry.size,
  };
}
