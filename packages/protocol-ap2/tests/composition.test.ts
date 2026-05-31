/**
 * AP2 ↔ inner-settlement COMPOSITION conformance (v3).
 *
 * Drives `runCompositionConformance` against the REAL `Ap2ProtocolAdapter`
 * (no subclass, no overrides) configured with a 3-protocol allow-list:
 *   x402-v1, cex-pay-v0.1, solana-pay-v1.
 *
 * `buildComposed402(settlementProtocol)` emits a genuine AP2 402 body carrying
 * a full Intent → Cart → Payment chain whose PaymentMandate.settlementProtocol
 * is the supplied inner protocol. This proves AP2 mandates compose with each
 * inner settlement layer — the composition is what's under test, not any single
 * protocol in isolation.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCompositionConformance } from "@openagentpay/conformance/compose";
import type { TestRunner } from "@openagentpay/conformance";
import {
  Ap2ProtocolAdapter,
  buildIntentMandate,
  buildCartMandate,
  buildPaymentMandate,
} from "../src/index.js";
import type {
  HttpResponse402,
  Mandate,
  ProtocolId,
} from "@openagentpay/core";

// Allow-list under test — these compose; anything else is rejected (case c).
const ALLOWED: readonly ProtocolId[] = [
  "x402-v1",
  "cex-pay-v0.1",
  "solana-pay-v1",
] as ProtocolId[];

// Structural proof — NullMandateVerifier (the adapter default) accepts any
// well-formed proof, so the chain validates without real crypto.
const proof: Mandate["proof"] = {
  type: "Ed25519Signature2020",
  created: "2026-05-21T00:00:00Z",
  verificationMethod: "did:openagent:user-alice#k1",
  proofPurpose: "assertionMethod",
  proofValue: "z3rEK4MN-composition-only",
};

const INTENT_ID = "urn:uuid:intent-compose-001";
const CART_ID = "urn:uuid:cart-compose-001";

function makeIntent(): Mandate {
  return buildIntentMandate({
    id: INTENT_ID,
    issuer: "did:openagent:user-alice",
    subjectId: "did:openagent:user-alice",
    description: "Buy market data under $5 via any allowed settlement layer",
    maxAmountAtomic: "5000000", // $5 cap — Cart total ($1) stays under
    currency: "USDC",
    decimals: 6,
    issuanceDate: "2026-05-21T00:00:00Z",
    expirationDate: "2027-05-21T00:00:00Z",
    proof,
  });
}

function makeCart(): Mandate {
  return buildCartMandate({
    id: CART_ID,
    issuer: "did:web:merchant.example",
    subjectId: "did:openagent:user-alice",
    intentMandateId: INTENT_ID,
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

/**
 * Payment Mandate whose settlementProtocol varies — this is the field that
 * makes the envelope "composed" with a specific inner settlement layer.
 */
function makePayment(settlementProtocol: string): Mandate {
  return buildPaymentMandate({
    id: "urn:uuid:payment-compose-001",
    issuer: "did:web:psp.example",
    subjectId: "did:openagent:user-alice",
    cartMandateId: CART_ID,
    settlementProtocol: settlementProtocol as ProtocolId,
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

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

runCompositionConformance(
  runner,
  {
    // Real adapter — allow-list drives the rejection case (c).
    createAdapter: () =>
      new Ap2ProtocolAdapter({ allowedSettlementProtocols: ALLOWED }),

    // Genuine AP2 402: full Intent → Cart → Payment chain, varying inner proto.
    buildComposed402: (settlementProtocol: string): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: {
        ap2Version: "0.1",
        mandates: [makeIntent(), makeCart(), makePayment(settlementProtocol)],
      },
    }),

    innerProtocols: ["x402-v1", "cex-pay-v0.1", "solana-pay-v1"],
  },
  { suiteName: "protocol-ap2 × inner-settlement composition" }
);
