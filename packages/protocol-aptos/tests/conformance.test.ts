/**
 * AptosPayProtocolAdapter ↔ Conformance suite — proves the adapter satisfies the
 * canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixtures reuse the exact 402 shapes from adapter.test.ts:
 *   - valid 402   → { aptosVersion: "1", coinType: native APT, ... } (detect → true)
 *   - foreign 402 → an x402 body { x402Version: 1 } — no aptosVersion/coinType,
 *                   so AptosPayProtocolAdapter.detect() returns false (verified
 *                   in adapter.test.ts "rejects non-Aptos body").
 *   - signed auth → carries a tx-hash `signature` so buildRetry() can emit the
 *                   X-PAYMENT-APTOS header (buildRetry is meaningfully
 *                   implemented → no skipBuildRetry).
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  AptosPayProtocolAdapter,
  PROTOCOL_ID,
  type AptosPay402Body,
} from "../src/index.js";

const validBody: AptosPay402Body = {
  aptosVersion: "1",
  recipient:
    "0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
  coinType: "0x1::aptos_coin::AptosCoin",
  amountAtomic: "10000000",
  network: "testnet",
  reference: "ord_aptos_001",
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
    createAdapter: () => new AptosPayProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — Aptos.detect() requires `aptosVersion` + `coinType`,
    // so this is foreign (mirrors adapter.test.ts "rejects non-Aptos body").
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
        amount: { amountAtomic: "10000000", decimals: 8, currency: "APT" },
        recipient: validBody.recipient,
        asset: { symbol: "APT", decimals: 8, chain: "aptos:testnet" },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: {},
      },
      signer: validBody.recipient,
      signature: "0xAPTOS_TX_HASH_xyz",
    }),
  },
  { suiteName: "protocol-aptos conformance" }
);
