/**
 * StellarSep31ProtocolAdapter ↔ Conformance suite — proves the adapter passes
 * the canonical `runProtocolConformance()` contract alongside the unit tests.
 *
 * Fixture shapes mirror tests/adapter.test.ts exactly:
 *   - valid 402   → { stellarVersion: "31", anchor: {...}, amount: {...} } (detect → true)
 *   - foreign 402 → an x402 body (no `stellarVersion`); detect() → false
 *                   (verified in adapter.test.ts: `{ x402Version: 1 }` is rejected)
 *   - signed auth → carries a base64 XDR `signature`, so buildRetry() emits the
 *                   X-PAYMENT-STELLAR header.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  StellarSep31ProtocolAdapter,
  PROTOCOL_ID,
  type Stellar402Body,
} from "../src/index.js";

const baseBody: Stellar402Body = {
  stellarVersion: "31",
  anchor: {
    domain: "circle.com",
    sendingAccount: "GABCDEF1234567890",
    receivingAccount: "GHIJKLMN1234567890",
    memoType: "text",
    memo: "ord_001",
  },
  amount: {
    value: "1000000",
    assetCode: "USDC",
    assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    decimals: 7,
  },
  description: "Cross-border micropayment",
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
    createAdapter: () => new StellarSep31ProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: baseBody,
    }),
    // x402-flavoured 402 — Stellar.detect() looks for `stellarVersion`, so this is foreign.
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
        amount: { amountAtomic: "1000000", decimals: 7, currency: "USDC" },
        recipient: "GHIJKLMN1234567890",
        asset: { symbol: "USDC", decimals: 7, chain: "stellar:pubnet" },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "ord_001",
        rawPayload: {},
      },
      signer: "GABCDEF",
      signature: "AAAAAgAAAA...XDR_BASE64",
    }),
  },
  { suiteName: "protocol-stellar conformance" }
);
