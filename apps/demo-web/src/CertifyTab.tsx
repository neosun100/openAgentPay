/**
 * CertifyTab — the federated conformance certifier showcase.
 *
 * Story: OpenAgentPay's conformance suite (25 wallet tests / 13 protocol tests)
 * is reusable by ANY third party. The `certify.yml` reusable workflow
 * (`workflow_call`) lets an external repo self-certify its own wallet/protocol
 * package: it installs, builds, runs that package's conformance test, and on
 * success emits an HMAC-signed {@link ConformanceCertificate}. The vision is a
 * federated registry (oapconformance.io) where anyone can publish + re-verify a
 * cert — turning "trust me, it conforms" into "here's a signed, checkable proof".
 *
 * The live API does not yet serve certs, so the cards below are CLEARLY LABELLED
 * "example certificates" — illustrative of the {@link ConformanceCertificate}
 * shape (subject / result {passed,total} / truncated signature proofValue).
 *
 * Mirrors WalletMatrixTab.tsx structure & styling.
 *
 * @license Apache-2.0
 */

import { useMemo } from "react";
import {
  formatCertResult,
  truncateProof,
  type CertResult,
} from "./certFormat.js";

// ----------------------------------------------------------------------------
//  Local cert shape — a structural mirror of @openagentpay/certifier's
//  ConformanceCertificate. Inlined (not imported) so the browser bundle stays
//  free of the certifier's node:crypto dependency; these are static examples.
// ----------------------------------------------------------------------------

type SubjectKind = "wallet" | "protocol";

interface ExampleCertificate {
  readonly id: string;
  readonly subject: string;
  readonly subjectKind: SubjectKind;
  readonly suiteVersion: string;
  readonly result: CertResult;
  readonly issuer: string;
  /** Full HMAC-SHA256 hex proofValue (truncated for display). */
  readonly proofValue: string;
}

// formatCertResult / truncateProof live in ./certFormat (pure + unit-tested).

// Re-export so existing importers can reach the helpers via this module too.
export { formatCertResult, truncateProof };

/**
 * Illustrative certificates — NOT served by the live API. Shaped exactly like
 * @openagentpay/certifier's ConformanceCertificate so the demo doubles as
 * documentation of the wire format.
 */
const EXAMPLE_CERTS: ReadonlyArray<ExampleCertificate> = [
  {
    id: "urn:uuid:8f2c1a90-3b7e-4d21-9c6a-1e0f5b2d4a77",
    subject: "@openagentpay/wallet-hashkey",
    subjectKind: "wallet",
    suiteVersion: "wallet-conformance@1",
    result: { passed: 25, skipped: 0, total: 25, allPassed: true },
    issuer: "oapconformance.io",
    proofValue:
      "9a3f7c2e1b8d04f6a5c9e2017d4b8e3f6a1c0d9b7e4f2a8c3d6b1e0f9a4c7d2e",
  },
  {
    id: "urn:uuid:1d4e8b32-6a09-4f15-b7c2-9e3a0d5f8c11",
    subject: "@openagentpay/wallet-movement",
    subjectKind: "wallet",
    suiteVersion: "wallet-conformance@1",
    result: { passed: 23, skipped: 2, total: 25, allPassed: true },
    issuer: "self-cert:movement-labs",
    proofValue:
      "c1e9b4a7d260f3851c7e0a9d4b2f6e83a5071c2d9f4b8e6a03d1c7b2e905f4a8",
  },
  {
    id: "urn:uuid:5b0c7d18-2e4a-4c93-8f61-7a9d2b0e3c54",
    subject: "@openagentpay/protocol-ap2",
    subjectKind: "protocol",
    suiteVersion: "protocol-conformance@1",
    result: { passed: 13, skipped: 0, total: 13, allPassed: true },
    issuer: "oapconformance.io",
    proofValue:
      "7e2d0a9c4b6f1837e5a0c9d24b1f8e60a3c7d915b4e2f8a6c0d3b1e7f9a5c4d0",
  },
  {
    id: "urn:uuid:a7f3e201-9c4d-4b88-a0e5-3d1f6b9c2e80",
    subject: "@openagentpay/protocol-x402",
    subjectKind: "protocol",
    suiteVersion: "protocol-conformance@1",
    result: { passed: 13, skipped: 0, total: 13, allPassed: true },
    issuer: "self-cert:acme-payments",
    proofValue:
      "3c9a7e1d0b524f86a3e0c7d91b4f2e85a6071c3d9b4e8f2a06c1d7b3e9f5a4c2",
  },
];

/** The 3-line caller workflow a third party drops into their own repo. */
const CALLER_YAML = `# .github/workflows/self-certify.yml
jobs:
  certify:
    uses: openagentpay/openAgentPay/.github/workflows/certify.yml@main
    with:
      package: "@yourorg/wallet-foo"`;

export function CertifyTab(): JSX.Element {
  const certifiedCount = useMemo(
    () => EXAMPLE_CERTS.filter((c) => c.result.allPassed).length,
    []
  );

  return (
    <section className="content tab-certify">
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Federated Conformance Certifier</h2>
          <p style={{ color: "var(--fg-dim)", margin: "4px 0 0", fontSize: 13 }}>
            任何第三方都能自证合规 — 58 钱包 × 32 框架的可验证信任层。
          </p>
        </div>
        <div className="matrix-stat">
          <span className="matrix-stat-num">58</span> wallets
          <span className="matrix-stat-sep">·</span>
          <span className="matrix-stat-num">32</span> frameworks
          <span className="matrix-stat-sep">·</span>
          <span className="matrix-stat-num">1</span> suite
        </div>
      </header>

      <p
        style={{
          color: "var(--fg-dim)",
          fontSize: 13,
          lineHeight: 1.6,
          maxWidth: 760,
          margin: "12px 0 24px",
        }}
      >
        OpenAgentPay's conformance suite (25 wallet tests / 13 protocol tests) is
        reusable by anyone. The <code>certify.yml</code> reusable workflow
        (<code>workflow_call</code>) lets an external repo self-certify its own
        wallet or protocol package — it installs, builds, runs that package's
        conformance test, and on success emits an HMAC-signed{" "}
        <code>ConformanceCertificate</code>. The vision is{" "}
        <strong>oapconformance.io</strong>: a federated registry where any third
        party publishes a signed, re-verifiable proof of conformance — turning
        "trust me" into a checkable signature.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "0 0 12px",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15 }}>Example certificates</h3>
        <span className="certify-example-tag" title="Illustrative only">
          example · not live API
        </span>
        <span style={{ fontSize: 12, color: "var(--fg-dim)" }}>
          {certifiedCount} of {EXAMPLE_CERTS.length} all-passed
        </span>
      </div>

      <div className="certify-grid">
        {EXAMPLE_CERTS.map((cert) => (
          <article key={cert.id} className="certify-card">
            <div className="certify-card-head">
              <span
                className={`certify-kind certify-kind-${cert.subjectKind}`}
              >
                {cert.subjectKind}
              </span>
              {cert.result.allPassed && (
                <span
                  className="certify-verified"
                  title="Signature verifiable against the issuer's HMAC secret"
                >
                  verified ✓
                </span>
              )}
            </div>

            <div className="certify-subject">{cert.subject}</div>

            <div className="certify-result">
              <span className="certify-result-num">
                {formatCertResult(cert.result)}
              </span>
              <span className="certify-suite">{cert.suiteVersion}</span>
            </div>

            <dl className="certify-meta">
              <div>
                <dt>issuer</dt>
                <dd>{cert.issuer}</dd>
              </div>
              <div>
                <dt>proofValue</dt>
                <dd className="certify-proof" title={cert.proofValue}>
                  {truncateProof(cert.proofValue)}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      <div className="certify-howto">
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>How to self-certify</h3>
        <p style={{ color: "var(--fg-dim)", fontSize: 13, margin: "0 0 12px" }}>
          Drop a 3-line caller workflow into your own repo — it invokes the
          reusable <code>certify.yml</code> via <code>workflow_call</code> with
          your package as input. No fork required.
        </p>
        <pre className="certify-code">
          <code>{CALLER_YAML}</code>
        </pre>
      </div>

      <footer
        style={{
          fontSize: 11,
          color: "var(--fg-dim)",
          paddingTop: 12,
          marginTop: 24,
          borderTop: "1px solid var(--bd-faint)",
        }}
      >
        Certificate shape mirrors <code>@openagentpay/certifier</code> (
        <code>issueCertificate</code> → <code>signCertificateHmac</code> →{" "}
        <code>verifyCertificateHmac</code>). The cards above are illustrative;
        the live API does not yet serve certs. Each cert is HMAC-SHA256 signed
        over canonical JSON so anyone holding the issuer's secret can re-verify.
      </footer>
    </section>
  );
}
