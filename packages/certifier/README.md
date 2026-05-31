# @openagentpay/certifier

Federated conformance certifier — the foundation for **oapconformance.io**.

Run the OpenAgentPay conformance suite against any wallet/protocol package,
then issue a **signed, verifiable `ConformanceCertificate`** so third parties
can self-certify their connectors and present a tamper-evident badge.

## Quick start

```ts
import {
  resultFromReport,
  issueCertificate,
  signCertificateHmac,
  verifyCertificateHmac,
  InMemoryCertificateRegistry,
} from "@openagentpay/certifier";

// `report` comes from runWalletConformance / runProtocolConformance
const cert = issueCertificate({
  subject: "@openagentpay/wallet-foo",
  subjectKind: "wallet",
  result: resultFromReport(report),
  issuer: "oapconformance.io",
});

const signed = signCertificateHmac(cert, process.env.OAP_CERT_SECRET!);
verifyCertificateHmac(signed, process.env.OAP_CERT_SECRET!); // → true

const registry = new InMemoryCertificateRegistry();
registry.issue(signed);
```

## Why `allPassed` is derived, never trusted

`issueCertificate` recomputes `allPassed` from the counts:

```
allPassed === (passed + skipped === total && passed > 0)
```

and **throws** if the caller-supplied flag disagrees. A connector can't claim
green while a test failed.

## Signature model

Mirrors `@openagentpay/core`'s receipt HMAC (`signReceiptHmac` /
`verifyReceiptHmac`): canonical JSON (recursively sorted keys, `signature`
omitted) → `HMAC-SHA256` → constant-time `timingSafeEqual` verify.

## CI

A reusable `.github/workflows/certify.yml` (`workflow_call` + `workflow_dispatch`)
installs, builds, runs a package's conformance test, and emits a certificate
JSON to the job summary on success.

— Apache-2.0
