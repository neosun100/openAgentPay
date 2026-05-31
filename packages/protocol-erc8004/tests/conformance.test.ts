/**
 * Erc8004ProtocolAdapter ↔ Conformance suite — proves the adapter satisfies the
 * canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixture shapes mirror tests/adapter.test.ts:
 *   - valid 402   → an `erc8004` block whose settlement.protocol === PROTOCOL_ID
 *                   (the conformance suite asserts req.protocol === adapter.id,
 *                   and parsePaymentRequired() returns settlement.protocol, so
 *                   the settlement protocol is pinned to "erc8004-v1" here).
 *   - foreign 402 → an x402 body { x402Version: 1, accepts: [...] }; detect()
 *                   requires an `erc8004` object, so this returns false
 *                   (verified against adapter.ts + adapter.test.ts line 41).
 *   - signed auth → carries a non-empty signature so buildRetry() emits the
 *                   X-PAYMENT-ERC8004 header.
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
  Erc8004ProtocolAdapter,
  PROTOCOL_ID,
  type Erc8004402Body,
} from "../src/index.js";

const validBody: Erc8004402Body = {
  erc8004: {
    version: 1,
    identity: {
      agentId: "did:eth:0xabc123",
      chain: "eip155:1",
      identityRegistry: "0xRegistry000000000000000000000000000000000",
    },
    reputation: {
      registry: "0xReputation0000000000000000000000000000000",
      score: 75,
    },
  },
  settlement: {
    // Pinned to PROTOCOL_ID so the conformance assertion
    // `req.protocol === adapter.id` holds (parse returns settlement.protocol).
    protocol: PROTOCOL_ID,
    payload: {
      recipient: "0xMERCHANT00000000000000000000000000000000",
      amount: "1000",
      decimals: 6,
      currency: "USDC",
      nonce: "0xabc",
      validBefore: 9_999_999_999,
    },
  },
  description: "Buy data",
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
    createAdapter: () => new Erc8004ProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — erc8004.detect() requires an `erc8004` object,
    // so this foreign body returns false.
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
        recipient: "0xMERCHANT00000000000000000000000000000000",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: {},
      },
      signer: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      signature: "0x" + "ab".repeat(65),
      encoded: "INNER",
    }),
  },
  { suiteName: "protocol-erc8004 conformance" }
);
