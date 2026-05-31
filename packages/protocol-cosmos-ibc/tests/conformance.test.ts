/**
 * CosmosIbcProtocolAdapter ↔ Conformance suite — proves the adapter satisfies
 * the canonical `runProtocolConformance()` contract (id / detect / parse /
 * buildRetry / error handling) alongside the unit tests.
 *
 * Fixtures reuse the exact 402 shape from adapter.test.ts so the conformance
 * run exercises the real wire format Cosmos IBC detects:
 *   - valid 402   → { cosmosIbcVersion: "1.0", ... } (detect → true)
 *   - foreign 402 → an x402 body with no cosmosIbcVersion (detect → false)
 *   - signed auth → buildRetry() base64url-encodes signer/signature into
 *                   X-PAYMENT-COSMOS, so it needs no extra fields.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type { HttpResponse402, SignedAuthorization } from "@openagentpay/core";
import {
  CosmosIbcProtocolAdapter,
  PROTOCOL_ID,
  type CosmosIbcBody,
} from "../src/index.js";

const validBody: CosmosIbcBody = {
  cosmosIbcVersion: "1.0",
  sourceChain: "cosmoshub-4",
  destChain: "osmosis-1",
  sourcePort: "transfer",
  sourceChannel: "channel-141",
  payee: "cosmos1abc123def456ghi789jkl012mno345pqr",
  denom: "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2",
  amount: { value: "1000000", currency: "ATOM", decimals: 6 },
  memo: "agent payment",
  nonce: "0xnoncecosmos",
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
    createAdapter: () => new CosmosIbcProtocolAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // x402-flavoured 402 — Cosmos IBC.detect() requires a string
    // `cosmosIbcVersion`, which this body lacks → foreign.
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
        amount: { amountAtomic: "1000000", decimals: 6, currency: "ATOM" },
        recipient: "cosmos1abc123def456ghi789jkl012mno345pqr",
        asset: {
          symbol: "ATOM",
          decimals: 6,
          contract:
            "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2",
        },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0xnoncecosmos",
        rawPayload: {},
      },
      signer: "cosmos1abc123def456ghi789jkl012mno345pqr",
      signature: "0xsig",
      extra: { sourceChannel: "channel-141" },
    }),
  },
  { suiteName: "protocol-cosmos-ibc conformance" }
);
