/**
 * NeverminedProtocolAdapter ↔ Conformance suite — proves the adapter satisfies
 * the canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixtures reuse the exact 402 shapes from adapter.test.ts:
 *   - valid 402   → subscription-mode body { nvmVersion: 1, ... } (detect → true)
 *   - foreign 402 → an x402 body with no nvmVersion              (detect → false)
 *   - signed auth → carries a signature so buildRetry() can emit X-PAYMENT-NVM.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  NeverminedProtocolAdapter,
  PROTOCOL_ID,
  type Nevermined402Body,
} from "../src/index.js";

const subBody: Nevermined402Body = {
  nvmVersion: 1,
  mode: "subscription",
  subscription: {
    planId: "plan-pro-001",
    tokenContract: "0xPlanContract000000000000000000000000000000",
    chain: "eip155:8453",
    priceAtomic: "10000000",
    currency: "USDC",
    decimals: 6,
    durationDays: 30,
  },
  description: "Pro plan: 30 days unlimited",
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
    createAdapter: () => new NeverminedProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: subBody,
    }),
    // x402-flavoured 402 — Nevermined.detect() requires `nvmVersion === 1`,
    // so this (no nvmVersion) is foreign and detect() returns false.
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
        amount: { amountAtomic: "10000000", decimals: 6, currency: "USDC" },
        recipient: "0xPlanContract000000000000000000000000000000",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "plan-pro-001",
        rawPayload: {},
      },
      signer: "0xAgent",
      signature: "0xsig",
    }),
  },
  { suiteName: "protocol-nevermined conformance" }
);
