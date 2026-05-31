/**
 * W3cPaymentRequestProtocolAdapter ↔ Conformance suite — proves the adapter
 * satisfies the canonical `runProtocolConformance()` contract (id / detect /
 * parse / buildRetry / error handling) alongside the unit tests.
 *
 * Fixture shapes mirror tests/adapter.test.ts exactly:
 *   - valid 402   → { w3cPaymentVersion: 1, methodData: [...], details: {...} } (detect → true)
 *   - foreign 402 → an x402 body { x402Version: 1, accepts: [...] }            (detect → false)
 *   - signed auth → carries `signature` (serialized PaymentResponse details) +
 *                   extra.methodName so buildRetry() emits the X-PAYMENT-W3C header.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  W3cPaymentRequestProtocolAdapter,
  PROTOCOL_ID,
  type W3cPayment402Body,
} from "../src/index.js";

const validBody: W3cPayment402Body = {
  w3cPaymentVersion: 1,
  methodData: [
    { supportedMethods: "basic-card" },
    { supportedMethods: "https://apple.com/apple-pay" },
  ],
  details: {
    id: "order-001",
    total: { label: "Total", amount: { currency: "USD", value: "1.99" } },
  },
  merchantOrigin: "https://merchant.example",
  description: "Premium article",
};

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

function buildValidResponse(): HttpResponse402 {
  return {
    statusCode: 402,
    headers: {},
    body: validBody,
  };
}

/**
 * An x402 402 — a clearly different protocol. It has no `w3cPaymentVersion`
 * field, so W3cPaymentRequestProtocolAdapter.detect() returns false (verified
 * against adapter.ts: detect() requires `w3cPaymentVersion === 1` and an array
 * `methodData`; adapter.test.ts confirms `{ x402Version: 1 }` is rejected).
 */
function buildForeignResponse(): HttpResponse402 {
  return {
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
  };
}

function buildSignedAuthorization(): SignedAuthorization {
  return {
    request: {
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "199", decimals: 2, currency: "USD" },
      recipient: "https://merchant.example",
      asset: { symbol: "USD", decimals: 2 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "order-001",
      rawPayload: {},
    },
    signer: "browser-payment-handler",
    signature: '{"cardNumber":"...masked..."}',
    extra: { methodName: "basic-card", spcAttestation: "AT_BASE64" },
  };
}

runProtocolConformance(
  runner,
  {
    createAdapter: () => new W3cPaymentRequestProtocolAdapter(),
    buildValidResponse,
    buildForeignResponse,
    buildSignedAuthorization,
  },
  { suiteName: "protocol-w3c-payment conformance" }
);
