/**
 * X402ProtocolAdapter ↔ Conformance suite — proves the adapter passes the
 * canonical `runProtocolConformance()` contract alongside the unit tests.
 *
 * Fixture shapes mirror tests/adapter.test.ts exactly:
 *   - valid 402   → { x402Version: 1, accepts: [exact@base-sepolia] } (detect → true)
 *   - foreign 402 → a Solana Pay body with no x402Version          (detect → false)
 *   - signed auth → carries request.asset.chain (CAIP-2) so buildRetry()
 *                   can infer `network` without signed.extra.
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
  X402ProtocolAdapter,
  PROTOCOL_ID_V1,
  type X402AcceptEntry,
} from "../src/index.js";

const baseAccept: X402AcceptEntry = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "1000",
  resource: "https://api.example.com/data",
  description: "Premium data access",
  mimeType: "application/json",
  payTo: "0x000000000000000000000000000000000000dead",
  maxTimeoutSeconds: 60,
  asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  extra: { name: "USDC", version: "2" },
};

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

function buildValidResponse(): HttpResponse402 {
  return {
    statusCode: 402,
    headers: {},
    body: { x402Version: 1, accepts: [baseAccept] },
  };
}

/**
 * A Solana Pay 402 — a clearly different protocol. It has no `x402Version`
 * field, so X402ProtocolAdapter.detect() returns false (verified against
 * adapter.ts: detect() requires a numeric x402Version in {1,2}).
 */
function buildForeignResponse(): HttpResponse402 {
  return {
    statusCode: 402,
    headers: {},
    body: {
      label: "Solana Pay Merchant",
      recipient: "9XQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      amount: "0.5",
      splToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      reference: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHQ5ng7m4kqj1jdq",
      message: "Order #1234",
    },
  };
}

function buildSignedAuthorization(): SignedAuthorization {
  return {
    request: {
      protocol: PROTOCOL_ID_V1,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:84532" },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
    },
    signer: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    signature: "0x" + "ab".repeat(65),
    extra: { network: "base-sepolia", scheme: "exact" },
  };
}

runProtocolConformance(
  runner,
  {
    createAdapter: () => new X402ProtocolAdapter(),
    buildValidResponse,
    buildForeignResponse,
    buildSignedAuthorization,
  },
  { suiteName: "protocol-x402 conformance" }
);
