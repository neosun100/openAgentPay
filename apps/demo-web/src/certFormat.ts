/**
 * certFormat — pure, dependency-free formatting helpers for the Certify tab.
 *
 * Extracted from CertifyTab.tsx so they can be unit-tested without a React/DOM
 * loader (demo-web has no vitest/jsdom infra). Imported back by CertifyTab.
 *
 * @license Apache-2.0
 */

/** Distilled conformance result — structural mirror of @openagentpay/certifier. */
export interface CertResult {
  readonly passed: number;
  readonly skipped: number;
  readonly total: number;
  readonly allPassed: boolean;
}

/**
 * Format a {@link CertResult} for display, e.g. "25/25 passed" or
 * "23/25 passed · 2 skipped".
 */
export function formatCertResult(result: CertResult): string {
  const { passed, skipped, total } = result;
  const skip = skipped > 0 ? ` · ${skipped} skipped` : "";
  return `${passed}/${total} passed${skip}`;
}

/** Truncate a long hex signature to `head…tail` for compact display. */
export function truncateProof(proof: string, head = 10, tail = 8): string {
  if (proof.length <= head + tail + 1) return proof;
  return `${proof.slice(0, head)}…${proof.slice(-tail)}`;
}
