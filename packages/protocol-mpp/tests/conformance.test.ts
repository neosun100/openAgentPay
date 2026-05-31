/**
 * MPP ProtocolAdapter ↔ Conformance suite — proves the adapter satisfies the
 * canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling).
 *
 * Fixtures reuse the exact 402 shapes from adapter.test.ts so the conformance
 * run exercises the real wire format MPP detects.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  MppProtocolAdapter,
  PROTOCOL_ID,
  type Mpp402Body,
} from "../src/index.js";

const validBody: Mpp402Body = {
  mppVersion: "0.1",
  merchant: {
    id: "stripe_acct_001",
    name: "Example Merchant",
    rails: ["tempo", "x402", "card"],
  },
  amount: { value: "1000", currency: "USDC", decimals: 6 },
  settlement: { rail: "tempo", details: { recipient: "tempo:merchant_001" } },
  description: "API access",
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
    createAdapter: () => new MppProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — MPP.detect() looks for `mppVersion`, so this is foreign.
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
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: "tempo:merchant_001",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: {},
      },
      signer: "agent",
      signature: "0xsig",
    }),
  },
  { suiteName: "protocol-mpp conformance" }
);
