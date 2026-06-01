/**
 * GNAP ProtocolAdapter ↔ Conformance suite — proves the adapter satisfies the
 * canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling).
 *
 * Fixtures reuse the GNAP grant shape so the conformance run exercises the
 * real wire format GNAP detects.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import { GnapProtocolAdapter, PROTOCOL_ID, type Gnap402Body } from "../src/index.js";

const validBody: Gnap402Body = {
  gnapVersion: "1",
  grantEndpoint: "https://as.example/grant",
  accessToken: { value: "gnap_tok_abc", manage: "https://as.example/token/abc" },
  access: [
    {
      type: "payment",
      actions: ["pay", "refund"],
      amount: { value: "1000", currency: "USDC", decimals: 6 },
      recipient: "0x000000000000000000000000000000000000dEaD",
    },
  ],
  interact: { redirect: "https://as.example/interact/xyz" },
};

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

runProtocolConformance(
  runner,
  {
    createAdapter: () => new GnapProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // bare x402 402 — GNAP.detect() looks for `gnapVersion`+`grantEndpoint`, so this is foreign.
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
        recipient: "0x000000000000000000000000000000000000dEaD",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: { gnap: validBody },
      },
      signer: "agent",
      signature: "0xsig",
    }),
  },
  { suiteName: "protocol-gnap conformance" }
);
