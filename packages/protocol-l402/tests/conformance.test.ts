/**
 * L402 protocol adapter ↔ Conformance suite — proves the adapter passes the
 * canonical `runProtocolConformance()` contract.
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
import { L402ProtocolAdapter, PROTOCOL_ID } from "../src/index.js";

const SAMPLE_MACAROON = "AGIAJEemVQUTEyNCR0exk7ek90Cg==";
// 1000 sat = 0.00001 BTC → encoded as "1000u" (1000 * 1e5 = 1e8 msat = 1000 sat)
const SAMPLE_INVOICE = "lnbc1000u1pwcvqkzpp5xyz";

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
    createAdapter: () => new L402ProtocolAdapter(),

    // A valid L402 402 — detect() returns true (www-authenticate starts with L402)
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {
        "www-authenticate": `L402 macaroon="${SAMPLE_MACAROON}", invoice="${SAMPLE_INVOICE}"`,
      },
      body: {},
    }),

    // A foreign protocol's 402 (x402 body, no www-authenticate header) — detect() → false
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
            payTo: "0x000000000000000000000000000000000000dEaD",
          },
        ],
      },
    }),

    // Valid signed authorization for buildRetry(): macaroon stashed as nonce,
    // preimage hex (32 bytes) in the signature field.
    buildSignedAuthorization: (): SignedAuthorization => ({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "100000000", decimals: 11, currency: "BTC" },
        recipient: "lightning-node",
        asset: { symbol: "BTC", decimals: 11 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: SAMPLE_MACAROON,
        rawPayload: {},
      },
      signer: "lightning-wallet",
      signature: "deadbeef".repeat(8), // 32-byte preimage hex
    }),
  },
  { suiteName: "protocol-l402 conformance" }
);
