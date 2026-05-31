/**
 * SuiPayProtocolAdapter ↔ Conformance suite — proves the adapter satisfies the
 * canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixtures reuse the exact 402 shapes from adapter.test.ts so the conformance
 * run exercises the real wire format Sui Pay detects:
 *   - valid 402   → sui-pay envelope with suiVersion + coinType (detect → true)
 *   - foreign 402 → an x402 body (no suiVersion/coinType)       (detect → false)
 *   - signed auth → signature carries the Sui tx digest so buildRetry() emits
 *                   the X-PAYMENT-SUI header.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type {
  HttpResponse402,
  SignedAuthorization,
} from "@openagentpay/core";
import {
  SuiPayProtocolAdapter,
  PROTOCOL_ID,
  type SuiPay402Body,
} from "../src/index.js";

const validBody: SuiPay402Body = {
  suiVersion: "1",
  recipient:
    "0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
  coinType: "0x2::sui::SUI",
  amountAtomic: "1000000000",
  network: "testnet",
  reference: "ord_sui_001",
  description: "Buy compute time",
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
    createAdapter: () => new SuiPayProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — Sui.detect() requires suiVersion + coinType, so this is foreign.
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
        amount: { amountAtomic: "1000000000", decimals: 9, currency: "SUI" },
        recipient: validBody.recipient,
        asset: { symbol: "SUI", decimals: 9, chain: "sui:testnet" },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "ord_sui_001",
        rawPayload: {},
      },
      signer: validBody.recipient,
      signature: "9z3rEK4MN_SUI_DIGEST",
    }),
  },
  { suiteName: "protocol-sui conformance" }
);
