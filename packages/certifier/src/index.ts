/**
 * @openagentpay/certifier
 * =======================
 *
 * A FEDERATED conformance certifier — the foundation for oapconformance.io.
 *
 * Third parties run the OpenAgentPay conformance suite against their own
 * wallet/protocol package, distill the {@link ConformanceReport} into a
 * {@link ConformanceResult}, issue a {@link ConformanceCertificate}, sign it
 * with an HMAC secret, and present a verifiable badge. Anyone holding the same
 * secret (or, in a hosted deployment, the certifier's public verification
 * endpoint) can re-check the signature.
 *
 *     import {
 *       resultFromReport,
 *       issueCertificate,
 *       signCertificateHmac,
 *       verifyCertificateHmac,
 *       InMemoryCertificateRegistry,
 *     } from "@openagentpay/certifier";
 *
 * @license Apache-2.0
 */

export {
  type ConformanceCertificate,
  type ConformanceResult,
  type ProofValue,
  type SubjectKind,
  type IssueCertificateInput,
  CertificateError,
  issueCertificate,
  signCertificateHmac,
  verifyCertificateHmac,
  canonicalCertificateJson,
} from "./certificate.js";

export {
  type CertificateRegistry,
  type RegistryEntry,
  type ListOptions,
  RegistryError,
  InMemoryCertificateRegistry,
} from "./registry.js";

export { CONFORMANCE_VERSION } from "@openagentpay/conformance";

export { resultFromReport } from "./report.js";

export {
  type ThirdPartyCertificationInput,
  type ThirdPartyCertificationResult,
  runThirdPartyCertification,
} from "./demo-thirdparty.js";

export {
  type CliResult,
  runCli,
  parseArgs,
} from "./cli.js";

