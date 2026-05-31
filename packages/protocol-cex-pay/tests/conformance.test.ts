/**
 * CexPayAdapter (OAP-CEX v0.1) ↔ Protocol Conformance suite.
 *
 * Proves the adapter satisfies the canonical `runProtocolConformance()` contract
 * defined in `@openagentpay/conformance/protocol`, alongside the bespoke
 * adapter.test.ts unit tests.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import type {
  HttpResponse402,
  ProtocolId,
  SignedAuthorization,
} from "@openagentpay/core";
import {
  CexPayAdapter,
  PROTOCOL_ID,
  encodeWireToken,
  type OapCex402Body,
  type OapCexWireToken,
} from "../src/adapter.js";

const baseAccept = {
  provider: "binance-pay",
  asset: "USDT",
  amount: "1000",
  amountDecimals: 6,
  recipient: "merchant_28571234",
  recipientType: "merchant_id" as const,
  validBefore: 9_999_999_999, // year 2286 — never expires in test runs
  nonce: "0x1aef000000000000000000000000000000000000000000000000000000008d92",
};

const validBody: OapCex402Body = {
  oapCexVersion: 1,
  scheme: "cex-pay",
  accepts: [baseAccept],
  description: "Premium analytics report",
};

const wireToken: OapCexWireToken = {
  oapCexVersion: 1,
  scheme: "cex-pay",
  provider: "binance-pay",
  authorization: {
    asset: "USDT",
    amount: "1000",
    amountDecimals: 6,
    from: "agent_94821",
    to: "merchant_28571234",
    nonce: baseAccept.nonce,
    validBefore: 9_999_999_999,
    signedAt: 1_778_860_654,
  },
  signature: { alg: "HMAC-SHA512", value: "9b3f1ae" },
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
    createAdapter: () => new CexPayAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: { ...validBody },
    }),
    // x402 body — detect() returns false because scheme !== "cex-pay".
    buildForeignResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: {
        x402Version: 1,
        scheme: "exact",
        accepts: [{ scheme: "exact", network: "base-sepolia" }],
      },
    }),
    buildSignedAuthorization: (): SignedAuthorization => ({
      request: {
        protocol: PROTOCOL_ID as ProtocolId,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
        recipient: "merchant_28571234",
        asset: { symbol: "USDT", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: baseAccept.nonce,
        rawPayload: {},
      },
      signer: "agent_94821",
      signature: "9b3f1ae",
      // buildRetry() mandates `encoded` — the base64url wire token (SPEC.md §5.3).
      encoded: encodeWireToken(wireToken),
    }),
  },
  { suiteName: "protocol-cex-pay conformance" }
);
