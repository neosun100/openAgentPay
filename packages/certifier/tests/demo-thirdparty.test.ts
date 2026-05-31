/**
 * Tests for the third-party integration demo + certifier-cli.
 *
 * Covers the canonical "how a third party self-certifies" round-trip plus the
 * CLI entrypoint, invoked programmatically (no shell spawn).
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type { ConformanceReport } from "@openagentpay/conformance";
import {
  CONFORMANCE_VERSION,
  runThirdPartyCertification,
  verifyCertificateHmac,
  CertificateError,
  InMemoryCertificateRegistry,
  runCli,
  parseArgs,
} from "../src/index.js";

const SECRET = "third-party-hmac-secret";

function passingReport(): ConformanceReport {
  return {
    suiteVersion: CONFORMANCE_VERSION,
    walletProvider: "@acme/wallet-foo",
    passed: 23,
    skipped: 2,
    total: 25,
  };
}

function failingReport(): ConformanceReport {
  return {
    suiteVersion: CONFORMANCE_VERSION,
    walletProvider: "@acme/wallet-foo",
    passed: 20,
    skipped: 0,
    total: 25,
  };
}

describe("runThirdPartyCertification", () => {
  it("happy path: issue → sign → store → verify true", () => {
    const out = runThirdPartyCertification(passingReport(), {
      subject: "@acme/wallet-foo",
      subjectKind: "wallet",
      secret: SECRET,
    });

    expect(out.verified).toBe(true);
    expect(out.registrySize).toBe(1);
    expect(out.certificate.subject).toBe("@acme/wallet-foo");
    expect(out.certificate.subjectKind).toBe("wallet");
    expect(out.certificate.result).toEqual({
      passed: 23,
      skipped: 2,
      total: 25,
      allPassed: true,
    });
    expect(out.certificate.signature?.type).toBe("HMAC-SHA256");
    expect(out.certificate.issuer).toBe("self-cert:third-party");
  });

  it("respects a custom issuer", () => {
    const out = runThirdPartyCertification(passingReport(), {
      subject: "@acme/wallet-foo",
      subjectKind: "wallet",
      secret: SECRET,
      issuer: "oapconformance.io",
    });
    expect(out.certificate.issuer).toBe("oapconformance.io");
  });

  it("tampered secret → re-verify with the wrong secret is false", () => {
    const out = runThirdPartyCertification(passingReport(), {
      subject: "@acme/wallet-foo",
      subjectKind: "wallet",
      secret: SECRET,
    });
    // The pipeline verified with the correct secret...
    expect(out.verified).toBe(true);
    // ...but a holder with the wrong secret cannot re-verify.
    expect(verifyCertificateHmac(out.certificate, "wrong-secret")).toBe(false);
  });

  it("all-passed=false report → runThirdPartyCertification throws CertificateError", () => {
    expect(() =>
      runThirdPartyCertification(failingReport(), {
        subject: "@acme/wallet-foo",
        subjectKind: "wallet",
        secret: SECRET,
      })
    ).toThrowError(CertificateError);
  });

  it("accumulates into a shared registry and revoke excludes from list", () => {
    const registry = new InMemoryCertificateRegistry();

    const a = runThirdPartyCertification(passingReport(), {
      subject: "@acme/wallet-foo",
      subjectKind: "wallet",
      secret: SECRET,
      registry,
    });
    const b = runThirdPartyCertification(
      { ...passingReport(), walletProvider: "@acme/wallet-bar" },
      {
        subject: "@acme/wallet-bar",
        subjectKind: "wallet",
        secret: SECRET,
        registry,
      }
    );

    expect(b.registrySize).toBe(2);
    expect(registry.list()).toHaveLength(2);

    expect(registry.revoke(a.certificate.id, "withdrawn")).toBe(true);
    const live = registry.list();
    expect(live).toHaveLength(1);
    expect(live[0]?.certificate.id).toBe(b.certificate.id);
    // Revoked entry is retained for audit.
    expect(registry.size).toBe(2);
    expect(registry.list({ includeRevoked: true })).toHaveLength(2);
  });

  it("re-reads the stored cert from the registry (round-trip), not the in-memory object", () => {
    const registry = new InMemoryCertificateRegistry();
    const out = runThirdPartyCertification(passingReport(), {
      subject: "@acme/protocol-x402",
      subjectKind: "protocol",
      secret: SECRET,
      registry,
    });
    const stored = registry.get(out.certificate.id);
    expect(stored).toBeDefined();
    expect(stored?.certificate).toEqual(out.certificate);
    expect(stored?.revoked).toBe(false);
  });
});

describe("certifier-cli (runCli)", () => {
  it("valid all-passed args print a verifiable signed cert and exit 0", () => {
    const res = runCli([
      "--subject",
      "@acme/wallet-foo",
      "--kind",
      "wallet",
      "--passed",
      "25",
      "--total",
      "25",
      "--secret",
      SECRET,
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");

    const cert = JSON.parse(res.stdout) as Parameters<typeof verifyCertificateHmac>[0];
    expect(cert.subject).toBe("@acme/wallet-foo");
    expect(cert.result.allPassed).toBe(true);
    expect(verifyCertificateHmac(cert, SECRET)).toBe(true);
  });

  it("emits an unsigned cert when no --secret is given", () => {
    const res = runCli([
      "--subject",
      "@acme/protocol-mpp",
      "--kind",
      "protocol",
      "--passed",
      "13",
      "--total",
      "13",
    ]);
    expect(res.code).toBe(0);
    const cert = JSON.parse(res.stdout) as { signature?: unknown; subjectKind: string };
    expect(cert.signature).toBeUndefined();
    expect(cert.subjectKind).toBe("protocol");
  });

  it("honors --skipped in the all-passed derivation", () => {
    const res = runCli([
      "--subject",
      "@acme/wallet-foo",
      "--kind",
      "wallet",
      "--passed",
      "23",
      "--skipped",
      "2",
      "--total",
      "25",
    ]);
    expect(res.code).toBe(0);
    const cert = JSON.parse(res.stdout) as { result: { skipped: number; allPassed: boolean } };
    expect(cert.result.skipped).toBe(2);
    expect(cert.result.allPassed).toBe(true);
  });

  it("allPassed false (failing run) exits non-zero with no stdout", () => {
    const res = runCli([
      "--subject",
      "@acme/wallet-foo",
      "--kind",
      "wallet",
      "--passed",
      "20",
      "--total",
      "25",
    ]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("NOT all-passed");
  });

  it("rejects an invalid --kind with exit code 2", () => {
    const res = runCli([
      "--subject",
      "@acme/wallet-foo",
      "--kind",
      "bogus",
      "--passed",
      "1",
      "--total",
      "1",
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--kind");
  });

  it("rejects a missing --subject with exit code 2", () => {
    const res = runCli(["--kind", "wallet", "--passed", "1", "--total", "1"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--subject");
  });

  it("rejects a non-integer --total with exit code 2", () => {
    const res = runCli([
      "--subject",
      "@acme/wallet-foo",
      "--kind",
      "wallet",
      "--passed",
      "1",
      "--total",
      "abc",
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--total");
  });

  it("parseArgs handles flag/value pairs and boolean flags", () => {
    expect(parseArgs(["--subject", "x", "--verbose", "--kind", "wallet"])).toEqual({
      subject: "x",
      verbose: "true",
      kind: "wallet",
    });
  });
});
