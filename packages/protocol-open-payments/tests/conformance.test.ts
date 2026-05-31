/**
 * OpenPaymentsProtocolAdapter ↔ Conformance suite — proves the adapter
 * satisfies the canonical `runProtocolConformance()` contract (id / detect /
 * parse / buildRetry / error handling) alongside the unit tests.
 *
 * Fixtures reuse the exact 402 shape from adapter.test.ts so the conformance
 * run exercises the real Open Payments / Interledger wire format:
 *   - valid 402   → { openPaymentsVersion: "1.0", incomingPayment, quote, ... } (detect → true)
 *   - foreign 402 → an x402 body with no `openPaymentsVersion`               (detect → false)
 *   - signed auth → buildRetry() only needs `signature` for the GNAP header.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  OpenPaymentsProtocolAdapter,
  PROTOCOL_ID,
  type OpenPaymentsBody,
} from "../src/index.js";

const validBody: OpenPaymentsBody = {
  openPaymentsVersion: "1.0",
  incomingPayment: {
    id: "https://wallet.example/incoming-payments/abc",
    walletAddress: "https://wallet.example/alice",
    incomingAmount: { value: "1000", assetCode: "USD", assetScale: 2 },
    description: "API access",
  },
  quote: {
    id: "https://wallet.example/quotes/xyz",
    debitAmount: { value: "1010", assetCode: "USD", assetScale: 2 },
    receiveAmount: { value: "1000", assetCode: "USD", assetScale: 2 },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  authServer: "https://auth.example/",
  resourceServer: "https://wallet.example/",
};

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

runProtocolConformance(
  runner,
  {
    createAdapter: () => new OpenPaymentsProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — OpenPayments.detect() requires a string
    // `openPaymentsVersion`, which this body lacks, so it's foreign.
    buildForeignResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base-sepolia",
            maxAmountRequired: "1000",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x000000000000000000000000000000000000dEaD",
          },
        ],
      },
    }),
    buildSignedAuthorization: (): SignedAuthorization => ({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1010", decimals: 2, currency: "USD" },
        recipient: "https://wallet.example/alice",
        asset: { symbol: "USD", decimals: 2 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "https://wallet.example/quotes/xyz",
        rawPayload: {},
      },
      signer: "alice",
      signature: "gnap-access-token-abc",
    }),
  },
  { suiteName: "protocol-open-payments conformance" }
);
