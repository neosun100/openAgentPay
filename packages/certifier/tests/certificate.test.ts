/**
 * Tests for @openagentpay/certifier — issuance, signing, verification, registry.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type { ConformanceReport } from "@openagentpay/conformance";
import {
  CONFORMANCE_VERSION,
  issueCertificate,
  signCertificateHmac,
  verifyCertificateHmac,
  canonicalCertificateJson,
  resultFromReport,
  CertificateError,
  InMemoryCertificateRegistry,
  RegistryError,
  type ConformanceCertificate,
  type ConformanceResult,
} from "../src/index.js";

const SECRET = "test-certifier-secret";

function passingResult(): ConformanceResult {
  return { passed: 23, skipped: 2, total: 25, allPassed: true };
}

function baseInput() {
  return {
    subject: "@openagentpay/wallet-foo",
    subjectKind: "wallet" as const,
    result: passingResult(),
    issuer: "oapconformance.io",
  };
}

describe("issueCertificate", () => {
  it("builds a certificate with a urn:uuid id and default suite version", () => {
    const cert = issueCertificate(baseInput());
    expect(cert.id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(cert.subject).toBe("@openagentpay/wallet-foo");
    expect(cert.subjectKind).toBe("wallet");
    expect(cert.suiteVersion).toBe(CONFORMANCE_VERSION);
    expect(cert.issuer).toBe("oapconformance.io");
    expect(cert.signature).toBeUndefined();
    expect(typeof cert.issuedAt).toBe("string");
  });

  it("respects suiteVersion + issuedAt overrides", () => {
    const cert = issueCertificate({
      ...baseInput(),
      suiteVersion: "9.9.9",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(cert.suiteVersion).toBe("9.9.9");
    expect(cert.issuedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("generates unique ids across issuances", () => {
    const a = issueCertificate(baseInput());
    const b = issueCertificate(baseInput());
    expect(a.id).not.toBe(b.id);
  });

  it("throws on empty subject", () => {
    expect(() => issueCertificate({ ...baseInput(), subject: "   " })).toThrow(
      CertificateError
    );
  });

  it("throws when allPassed=true but a test failed (counts inconsistent)", () => {
    // passed+skipped (20+2=22) != total (25) → one failed → allPassed must be false
    expect(() =>
      issueCertificate({
        ...baseInput(),
        result: { passed: 20, skipped: 2, total: 25, allPassed: true },
      })
    ).toThrow(/inconsistent/);
  });

  it("throws when allPassed=true but zero tests ran", () => {
    expect(() =>
      issueCertificate({
        ...baseInput(),
        result: { passed: 0, skipped: 0, total: 0, allPassed: true },
      })
    ).toThrow(CertificateError);
  });

  it("allows allPassed=false when a test failed", () => {
    const cert = issueCertificate({
      ...baseInput(),
      result: { passed: 20, skipped: 2, total: 25, allPassed: false },
    });
    expect(cert.result.allPassed).toBe(false);
  });
});

describe("resultFromReport", () => {
  it("derives allPassed=true when passed+skipped===total and passed>0", () => {
    const report: ConformanceReport = {
      suiteVersion: CONFORMANCE_VERSION,
      walletProvider: "foo",
      passed: 24,
      skipped: 1,
      total: 25,
    };
    expect(resultFromReport(report)).toEqual({
      passed: 24,
      skipped: 1,
      total: 25,
      allPassed: true,
    });
  });

  it("derives allPassed=false when a test failed", () => {
    const report: ConformanceReport = {
      suiteVersion: CONFORMANCE_VERSION,
      walletProvider: "foo",
      passed: 20,
      skipped: 0,
      total: 25,
    };
    expect(resultFromReport(report).allPassed).toBe(false);
  });

  it("feeds cleanly into issueCertificate", () => {
    const report: ConformanceReport = {
      suiteVersion: CONFORMANCE_VERSION,
      walletProvider: "bar",
      passed: 25,
      skipped: 0,
      total: 25,
    };
    const cert = issueCertificate({
      subject: "@openagentpay/wallet-bar",
      subjectKind: "wallet",
      result: resultFromReport(report),
      issuer: "self",
    });
    expect(cert.result.allPassed).toBe(true);
  });
});

describe("signCertificateHmac / verifyCertificateHmac", () => {
  it("sign + verify round-trips", () => {
    const cert = issueCertificate(baseInput());
    const signed = signCertificateHmac(cert, SECRET);
    expect(signed.signature).toBeDefined();
    expect(signed.signature?.type).toBe("HMAC-SHA256");
    expect(signed.signature?.proofValue).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCertificateHmac(signed, SECRET)).toBe(true);
  });

  it("does not mutate the input certificate", () => {
    const cert = issueCertificate(baseInput());
    signCertificateHmac(cert, SECRET);
    expect(cert.signature).toBeUndefined();
  });

  it("verify=false for the wrong secret", () => {
    const signed = signCertificateHmac(issueCertificate(baseInput()), SECRET);
    expect(verifyCertificateHmac(signed, "wrong-secret")).toBe(false);
  });

  it("verify=false for an unsigned certificate", () => {
    expect(verifyCertificateHmac(issueCertificate(baseInput()), SECRET)).toBe(
      false
    );
  });

  it("verify=false when the certificate body is tampered", () => {
    const signed = signCertificateHmac(issueCertificate(baseInput()), SECRET);
    const tampered: ConformanceCertificate = {
      ...signed,
      subject: "@openagentpay/wallet-evil",
    };
    expect(verifyCertificateHmac(tampered, SECRET)).toBe(false);
  });

  it("verify=false when the result counts are tampered", () => {
    const signed = signCertificateHmac(issueCertificate(baseInput()), SECRET);
    const tampered: ConformanceCertificate = {
      ...signed,
      result: { passed: 25, skipped: 0, total: 25, allPassed: true },
    };
    expect(verifyCertificateHmac(tampered, SECRET)).toBe(false);
  });

  it("canonical JSON is stable regardless of key order and omits signature", () => {
    const signed = signCertificateHmac(issueCertificate(baseInput()), SECRET);
    const canon = canonicalCertificateJson(signed);
    expect(canon).not.toContain("signature");
    // re-canonicalising the unsigned twin yields identical bytes
    const { signature: _s, ...unsigned } = signed;
    void _s;
    expect(canonicalCertificateJson(unsigned as ConformanceCertificate)).toBe(
      canon
    );
  });

  it("respects created/verificationMethod overrides", () => {
    const signed = signCertificateHmac(issueCertificate(baseInput()), SECRET, {
      created: "2026-01-01T00:00:00.000Z",
      verificationMethod: "did:example:123",
    });
    expect(signed.signature?.created).toBe("2026-01-01T00:00:00.000Z");
    expect(signed.signature?.verificationMethod).toBe("did:example:123");
    expect(verifyCertificateHmac(signed, SECRET)).toBe(true);
  });
});

describe("InMemoryCertificateRegistry", () => {
  it("issue + get round-trips", () => {
    const reg = new InMemoryCertificateRegistry();
    const cert = issueCertificate(baseInput());
    const entry = reg.issue(cert);
    expect(entry.revoked).toBe(false);
    expect(reg.get(cert.id)?.certificate.id).toBe(cert.id);
    expect(reg.size).toBe(1);
  });

  it("get returns undefined for unknown id", () => {
    const reg = new InMemoryCertificateRegistry();
    expect(reg.get("urn:uuid:nope")).toBeUndefined();
  });

  it("throws on duplicate id", () => {
    const reg = new InMemoryCertificateRegistry();
    const cert = issueCertificate(baseInput());
    reg.issue(cert);
    expect(() => reg.issue(cert)).toThrow(RegistryError);
  });

  it("list filters by subject", () => {
    const reg = new InMemoryCertificateRegistry();
    reg.issue(issueCertificate({ ...baseInput(), subject: "@oap/a" }));
    reg.issue(issueCertificate({ ...baseInput(), subject: "@oap/a" }));
    reg.issue(issueCertificate({ ...baseInput(), subject: "@oap/b" }));
    expect(reg.list({ subject: "@oap/a" }).length).toBe(2);
    expect(reg.list({ subject: "@oap/b" }).length).toBe(1);
    expect(reg.list().length).toBe(3);
  });

  it("revoke soft-removes from default list but keeps it stored", () => {
    const reg = new InMemoryCertificateRegistry();
    const cert = issueCertificate(baseInput());
    reg.issue(cert);
    expect(reg.revoke(cert.id, "key compromised")).toBe(true);
    expect(reg.list().length).toBe(0);
    expect(reg.list({ includeRevoked: true }).length).toBe(1);
    const entry = reg.get(cert.id);
    expect(entry?.revoked).toBe(true);
    expect(entry?.revokedReason).toBe("key compromised");
    expect(reg.size).toBe(1);
  });

  it("revoke returns false for unknown id", () => {
    const reg = new InMemoryCertificateRegistry();
    expect(reg.revoke("urn:uuid:nope")).toBe(false);
  });
});
