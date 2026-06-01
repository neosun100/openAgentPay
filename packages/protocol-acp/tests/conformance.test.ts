/**
 * ACP ProtocolAdapter ↔ Conformance suite — proves the adapter satisfies the
 * canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling).
 *
 * `buildForeignResponse` is a bare x402 402 — ACP.detect() requires
 * `acpVersion` + `checkoutSessionId` + `lineItems`, so x402 is foreign.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import { AcpProtocolAdapter, PROTOCOL_ID, type Acp402Body } from "../src/index.js";

const validBody: Acp402Body = {
  acpVersion: "0.1",
  checkoutSessionId: "cs_acp_001",
  merchant: { id: "stripe_acct_001", name: "Example Store" },
  lineItems: [
    { name: "Widget", quantity: 2, unitAmount: { value: "500", currency: "USDC", decimals: 6 } },
  ],
  total: { value: "1000", currency: "USDC", decimals: 6 },
  settlement: { rail: "stablecoin", recipient: "0xMerchantWallet" },
  expiresAt: 9_999_999_999,
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
    createAdapter: () => new AcpProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — ACP.detect() looks for `acpVersion`, so this is foreign.
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
        recipient: "0xMerchantWallet",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: { acp: validBody },
      },
      signer: "agent",
      signature: "0xsig",
    }),
  },
  { suiteName: "protocol-acp conformance" }
);
