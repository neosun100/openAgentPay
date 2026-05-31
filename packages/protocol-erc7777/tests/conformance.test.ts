/**
 * Erc7777ProtocolAdapter ↔ Conformance suite — proves the adapter satisfies the
 * canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixture shapes mirror tests/adapter.test.ts exactly:
 *   - valid 402   → { erc7777Version: "1.0", identityRegistry/agentId/ruleSet,
 *                     settlement:{...} }                         (detect → true)
 *   - foreign 402 → an x402 body { x402Version: 1, accepts:[...] }; it has no
 *                   `erc7777Version`, so detect() returns false (verified against
 *                   adapter.ts: detect() requires a string erc7777Version
 *                   starting with "1").
 *   - signed auth → carries signature + signer so buildRetry() can emit the
 *                   X-PAYMENT-ERC7777 header (buildRetry is meaningfully
 *                   implemented → no skipBuildRetry).
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
  Erc7777ProtocolAdapter,
  PROTOCOL_ID,
  type Erc7777Body,
} from "../src/index.js";

const validBody: Erc7777Body = {
  erc7777Version: "1.0",
  identityRegistry: "0xRegistry",
  agentId: "0xAgent01",
  ruleSet: "0xRules01",
  attestation: "0xAttest01",
  settlement: {
    amount: { value: "1000000", currency: "USDC", decimals: 6 },
    recipient: "0xMerchant",
    chain: "eip155:1",
  },
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
    body: validBody,
  };
}

/**
 * An x402 402 — a clearly different protocol. It has no `erc7777Version`
 * field, so Erc7777ProtocolAdapter.detect() returns false.
 */
function buildForeignResponse(): HttpResponse402 {
  return {
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
  };
}

function buildSignedAuthorization(): SignedAuthorization {
  return {
    request: {
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      recipient: "0xMerchant",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:1" },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
    },
    signer: "0xSigner",
    signature: "0xsig",
    extra: { ruleSet: "0xRules01" },
  };
}

runProtocolConformance(
  runner,
  {
    createAdapter: () => new Erc7777ProtocolAdapter(),
    buildValidResponse,
    buildForeignResponse,
    buildSignedAuthorization,
  },
  { suiteName: "protocol-erc7777 conformance" }
);
