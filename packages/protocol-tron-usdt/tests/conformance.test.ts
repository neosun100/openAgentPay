/**
 * TronUsdtProtocolAdapter ↔ Conformance suite — proves the adapter satisfies
 * the canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixtures reuse the exact 402 shapes from adapter.test.ts so the conformance
 * run exercises the real wire format the adapter detects:
 *   - valid 402   → { tronUsdtVersion: "1.0", ... }            (detect → true)
 *   - foreign 402 → an x402 body (no `tronUsdtVersion`)        (detect → false)
 *   - signed auth → buildRetry() is meaningfully implemented   (no skipBuildRetry)
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  TronUsdtProtocolAdapter,
  PROTOCOL_ID,
  type TronUsdtBody,
} from "../src/index.js";

const validBody: TronUsdtBody = {
  tronUsdtVersion: "1.0",
  network: "shasta",
  contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  amount: { value: "1000000", currency: "USDT", decimals: 6 },
  recipient: "TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY", // 34-char base58 starting with T
  validBefore: Math.floor(Date.now() / 1000) + 600,
  nonce: "0xnoncedeadbeef",
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
    createAdapter: () => new TronUsdtProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — TRON-USDT.detect() requires `tronUsdtVersion`, so this is foreign.
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
        amount: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
        recipient: "TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY",
        asset: {
          symbol: "USDT",
          decimals: 6,
          contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0xnoncedeadbeef",
        rawPayload: {},
      },
      signer: "TSigner1234567890123456789012345678",
      signature: "0xsig",
    }),
  },
  { suiteName: "protocol-tron-usdt conformance" }
);
