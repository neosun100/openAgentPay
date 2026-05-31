/**
 * HederaHcsProtocolAdapter ↔ Conformance suite — proves the adapter satisfies
 * the canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixtures reuse the exact 402 shapes from adapter.test.ts:
 *   - valid 402   → { hederaVersion: "1.0", ... } (detect → true)
 *   - foreign 402 → an x402 body with no `hederaVersion` (detect → false,
 *                   verified against adapter.ts: detect() requires a string
 *                   `hederaVersion`).
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  HederaHcsProtocolAdapter,
  PROTOCOL_ID,
  type HederaHcsBody,
} from "../src/index.js";

const validBody: HederaHcsBody = {
  hederaVersion: "1.0",
  network: "testnet",
  payee: "0.0.12345",
  token: "USDC",
  tokenId: "0.0.456858",
  amount: { value: "1000000", currency: "USDC", decimals: 6 },
  memo: "API call",
  validBefore: Math.floor(Date.now() / 1000) + 600,
  nonce: "0xnoncehedera",
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
    createAdapter: () => new HederaHcsProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — Hedera.detect() looks for `hederaVersion`, so this is foreign.
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
        amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
        recipient: "0.0.12345",
        asset: { symbol: "USDC", decimals: 6, contract: "0.0.456858" },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: {},
      },
      signer: "0.0.99999",
      signature: "0x" + "ab".repeat(65),
      extra: { network: "testnet" },
    }),
  },
  { suiteName: "protocol-hedera-hcs conformance" }
);
