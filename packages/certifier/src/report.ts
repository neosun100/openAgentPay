/**
 * resultFromReport — distill a raw {@link ConformanceReport} into a signable
 * {@link ConformanceResult}.
 *
 * Kept in its own module (rather than inline in index.ts) so internal modules
 * like {@link runThirdPartyCertification} can import it without creating a
 * circular dependency through the package barrel.
 *
 * @license Apache-2.0
 */

import type { ConformanceReport } from "@openagentpay/conformance";
import type { ConformanceResult } from "./certificate.js";

/**
 * Distill a raw {@link ConformanceReport} (from runWalletConformance /
 * runProtocolConformance) into the signable {@link ConformanceResult} embedded
 * in a certificate. `allPassed` is derived — never trusted from the report.
 */
export function resultFromReport(report: ConformanceReport): ConformanceResult {
  const { passed, skipped, total } = report;
  return {
    passed,
    skipped,
    total,
    allPassed: passed + skipped === total && passed > 0,
  };
}
