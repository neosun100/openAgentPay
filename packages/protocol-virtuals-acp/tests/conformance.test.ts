/**
 * VirtualsAcpProtocolAdapter ↔ Conformance suite — proves the adapter passes
 * the canonical `runProtocolConformance()` contract alongside the unit tests.
 *
 * Fixture shapes mirror tests/adapter.test.ts exactly:
 *   - valid 402   → { acpVersion: 1, job: { phase: "transaction", ... } } (detect → true)
 *   - foreign 402 → an x402 body { x402Version: 1, accepts: [...] }      (detect → false,
 *                   verified against adapter.ts: detect() requires acpVersion === 1)
 *   - signed auth → matches the buildRetry() unit-test shape; buildRetry() is
 *                   meaningfully implemented (emits X-PAYMENT-ACP header), so
 *                   skipBuildRetry is NOT used.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  VirtualsAcpProtocolAdapter,
  PROTOCOL_ID,
  type Acp402Body,
} from "../src/index.js";

const validBody: Acp402Body = {
  acpVersion: 1,
  job: {
    id: "job_001",
    requesterAgent: "0xRequester",
    providerAgent: "0xProvider",
    evaluatorAgent: "0xEvaluator",
    phase: "transaction",
    terms: { description: "Generate research report", deliverable: "PDF + dataset" },
    priceAtomic: "5000000",
    currency: "USDC",
    decimals: 6,
    escrow: "0xEscrow000000000000000000000000000000000000",
    chain: "eip155:8453",
  },
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
    createAdapter: () => new VirtualsAcpProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — ACP.detect() requires `acpVersion === 1`, so this is foreign.
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
        amount: { amountAtomic: "5000000", decimals: 6, currency: "USDC" },
        recipient: "0xEscrow000000000000000000000000000000000000",
        asset: { symbol: "USDC", decimals: 6, chain: "eip155:8453" },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "job_001",
        rawPayload: {},
      },
      signer: "0xRequester",
      signature: "0xsig",
    }),
  },
  { suiteName: "protocol-virtuals-acp conformance" }
);
