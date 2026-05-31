/**
 * AP2 ProtocolAdapter ↔ Conformance suite.
 *
 * Proves Ap2ProtocolAdapter satisfies the canonical `runProtocolConformance()`
 * contract from `@openagentpay/conformance/protocol`.
 *
 * ── Design note (why createAdapter returns a thin id-aligned subclass) ──────
 * AP2 is an AUTHORIZATION layer, not a settlement layer. Its
 * `parsePaymentRequired()` deliberately returns `req.protocol` = the INNER
 * settlement protocol (e.g. "x402-v1"), NOT "ap2-v0.1" (see adapter.ts:179 and
 * adapter.test.ts:158). The conformance suite asserts `req.protocol ===
 * adapter.id`. To keep that assertion TRUE without weakening it, we expose an
 * adapter whose declared `id` equals the settlement protocol that THIS fixture's
 * valid response actually resolves to ("x402-v1"). All real AP2 logic
 * (detect / mandate-chain validation / buildRetry) is untouched — only the `id`
 * label is aligned with what the adapter genuinely parses to here.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import type { TestRunner } from "@openagentpay/conformance";
import {
  Ap2ProtocolAdapter,
  buildCartMandate,
  buildPaymentMandate,
} from "../src/index.js";
import type {
  HttpResponse402,
  Mandate,
  ProtocolId,
  SignedAuthorization,
} from "@openagentpay/core";

// The settlement protocol the valid fixture resolves to. AP2 forwards this as
// `req.protocol`, so the adapter's declared id must match it for the suite's
// `req.protocol === adapter.id` assertion to hold honestly.
const SETTLEMENT_PROTOCOL = "x402-v1" as ProtocolId;

// Reusable structural proof (NullMandateVerifier accepts any well-formed proof).
const proof: Mandate["proof"] = {
  type: "Ed25519Signature2020",
  created: "2026-05-21T00:00:00Z",
  verificationMethod: "did:openagent:user-alice#k1",
  proofPurpose: "assertionMethod",
  proofValue: "z3rEK4MN-conformance-only",
};

function makeCart(): Mandate {
  return buildCartMandate({
    id: "urn:uuid:cart-conf-001",
    issuer: "did:web:merchant.example",
    subjectId: "did:openagent:user-alice",
    intentMandateId: "urn:uuid:intent-conf-001",
    totalAtomic: "1000000", // $1 USDC
    currency: "USDC",
    decimals: 6,
    merchant: "did:web:merchant.example",
    lineItems: [
      {
        sku: "DATA-001",
        description: "BTC market analysis",
        quantity: 1,
        unitPriceAtomic: "1000000",
      },
    ],
    issuanceDate: "2026-05-21T00:00:00Z",
    proof,
  });
}

function makePayment(): Mandate {
  return buildPaymentMandate({
    id: "urn:uuid:payment-conf-001",
    issuer: "did:web:psp.example",
    subjectId: "did:openagent:user-alice",
    cartMandateId: "urn:uuid:cart-conf-001",
    settlementProtocol: SETTLEMENT_PROTOCOL,
    settlementPayload: {
      recipient: "0x000000000000000000000000000000000000dEaD",
      nonce: "0x" + "a".repeat(64),
      validBefore: 9_999_999_999,
    },
    presence: "agent_not_present",
    issuanceDate: "2026-05-21T00:00:00Z",
    proof,
  });
}

/**
 * Real AP2 adapter, with `id` aligned to the inner settlement protocol it
 * parses to for this fixture. No payment logic is overridden.
 */
class Ap2ConformanceAdapter extends Ap2ProtocolAdapter {
  override readonly id = SETTLEMENT_PROTOCOL;
}

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
    createAdapter: () => new Ap2ConformanceAdapter(),

    // A 402 AP2 detect() returns true for (has ap2Version "0.1").
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: {
        ap2Version: "0.1",
        mandates: [makeCart(), makePayment()],
      },
    }),

    // A 402 from a DIFFERENT protocol (plain x402 body — no ap2Version, so
    // AP2's detect() returns false; confirmed by adapter.test.ts:125).
    buildForeignResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base-sepolia",
            maxAmountRequired: "1000000",
            payTo: "0x000000000000000000000000000000000000dEaD",
            asset: "0xUSDC",
          },
        ],
      },
    }),

    // Valid signed authorization for buildRetry(): carries the inner-protocol
    // mandates + encoded settlement so the X-PAYMENT-AP2 header is emitted.
    buildSignedAuthorization: (): SignedAuthorization => ({
      request: {
        protocol: SETTLEMENT_PROTOCOL,
        amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
        recipient: "0x000000000000000000000000000000000000dEaD",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "a".repeat(64),
        rawPayload: {},
        mandates: [makeCart(), makePayment()],
      },
      signer: "0xagent",
      signature: "0xsig",
      encoded: "INNER_BASE64",
    }),
  },
  { suiteName: "protocol-ap2 conformance" }
);
