/**
 * Web Monetization ProtocolAdapter ↔ Conformance suite — proves the adapter
 * satisfies the canonical `runProtocolConformance()` contract (id / detect /
 * parse / buildRetry / error handling).
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  WebMonetizationProtocolAdapter,
  PROTOCOL_ID,
  type Wm402Body,
} from "../src/index.js";

const validBody: Wm402Body = {
  wmVersion: "1",
  paymentPointer: "$wallet.example.com/alice",
  asset: { code: "USD", scale: 9 },
  amount: { value: "1000000" },
  receiptsEnabled: true,
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
    createAdapter: () => new WebMonetizationProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // bare x402 402 — WM.detect() looks for `wmVersion` + `paymentPointer`, so this is foreign.
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
        amount: { amountAtomic: "1000000", decimals: 9, currency: "USD" },
        recipient: "https://wallet.example.com/alice",
        asset: { symbol: "USD", decimals: 9 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: {},
      },
      signer: "agent",
      signature: "0xsig",
    }),
  },
  { suiteName: "protocol-web-monetization conformance" }
);
