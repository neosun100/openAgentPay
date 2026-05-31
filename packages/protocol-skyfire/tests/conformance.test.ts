/**
 * SkyfireProtocolAdapter ↔ Conformance suite — proves the adapter passes the
 * canonical `runProtocolConformance()` contract alongside the unit tests.
 *
 * Fixture shapes mirror tests/adapter.test.ts exactly:
 *   - valid 402   → { skyfire: { version: 1, amount, recipient, merchantUrl, ... } } (detect → true)
 *   - foreign 402 → an x402 body { x402Version: 1, accepts: [...] }; Skyfire.detect()
 *                   requires a `skyfire` block, so this is rejected (detect → false)
 *   - signed auth → carries the PAY token in `signature` + KYA token in `extra`
 *                   so buildRetry() emits both headers.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  SkyfireProtocolAdapter,
  PROTOCOL_ID,
  type Skyfire402Body,
} from "../src/index.js";

const validBody: Skyfire402Body = {
  skyfire: {
    version: 1,
    amount: { amountAtomic: "1000", currency: "USDC", decimals: 6 },
    recipient: "merchant_skyfire_001",
    merchantUrl: "https://api.example.com/data",
    requireKya: true,
    accepts: ["usdc-base", "card"],
    description: "Premium API",
  },
};

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

function buildValidResponse(): HttpResponse402 {
  return { statusCode: 402, headers: {}, body: validBody };
}

/**
 * An x402 402 — a clearly different protocol. It has no `skyfire` block, so
 * SkyfireProtocolAdapter.detect() returns false (verified against adapter.ts:
 * detect() requires body.skyfire to be an object).
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
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "merchant_skyfire_001",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
    },
    signer: "agent",
    signature: "PAY_TOKEN_xyz", // PAY token issued by Skyfire after wallet authorizes
    extra: { kyaToken: "KYA_JWT_abc" },
  };
}

runProtocolConformance(
  runner,
  {
    createAdapter: () => new SkyfireProtocolAdapter(),
    buildValidResponse,
    buildForeignResponse,
    buildSignedAuthorization,
  },
  { suiteName: "protocol-skyfire conformance" }
);
