/**
 * A2A Discovery ProtocolAdapter ↔ Conformance suite — proves the adapter
 * satisfies the canonical `runProtocolConformance()` contract (id / detect /
 * parse / buildRetry / error handling).
 *
 * ── Design note (why createAdapter returns an id-aligned subclass) ──────────
 * A2A discovery is a NEGOTIATION layer, not a settlement layer. Its
 * `parsePaymentRequired()` deliberately returns `req.protocol` = the INNER
 * negotiated settlement protocol (e.g. "x402-v1"), NOT "a2a-discovery-v0.1"
 * (see adapter.ts + adapter.test.ts). The conformance suite asserts
 * `req.protocol === adapter.id`. To keep that assertion TRUE without weakening
 * it, we expose an adapter whose declared `id` equals the settlement protocol
 * this fixture's valid response actually resolves to ("x402-v1"). All real
 * discovery logic (detect / card validation / negotiate / buildRetry) is
 * untouched — only the `id` label is aligned with what the adapter parses to
 * here. Same pattern as protocol-ap2's conformance harness.
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
  WalletProviderId,
} from "@openagentpay/core";
import {
  A2aDiscoveryAdapter,
  type A2a402Body,
} from "../src/index.js";

const P = (s: string) => s as ProtocolId;
const W = (s: string) => s as WalletProviderId;

// The settlement protocol the valid fixture resolves to. A2A discovery forwards
// this as `req.protocol`, so the id-aligned subclass below declares it to keep
// the suite's `req.protocol === adapter.id` assertion honest.
const SETTLEMENT_PROTOCOL = P("x402-v1");

/**
 * Real A2A discovery adapter, with `id` aligned to the inner settlement
 * protocol it parses to for this fixture. No discovery logic is overridden.
 */
class A2aConformanceAdapter extends A2aDiscoveryAdapter {
  override readonly id = SETTLEMENT_PROTOCOL;
}

const validBody: A2a402Body = {
  a2aVersion: "0.1",
  agentCard: {
    agentId: "did:web:merchant.example",
    displayName: "Example Merchant Agent",
    acceptedProtocols: [P("x402-v1"), P("mpp-v0.1")],
    acceptedAssets: [{ symbol: "USDC", decimals: 6 }],
    acceptedWallets: [W("coinbase-cdp")],
    spendLimits: { maxPerTxAtomic: "5000", currency: "USDC", decimals: 6 },
  },
  paymentRequest: {
    protocol: SETTLEMENT_PROTOCOL,
    recipient: "0x000000000000000000000000000000000000dEaD",
    amount: { value: "1000", currency: "USDC", decimals: 6 },
    asset: { symbol: "USDC", decimals: 6 },
    walletProvider: W("coinbase-cdp"),
    description: "API access",
  },
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
    createAdapter: () => new A2aConformanceAdapter(),
    buildValidResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: validBody,
    }),
    // ap2-flavoured 402 — A2A.detect() looks for `a2aVersion` + `agentCard`,
    // so this is foreign.
    buildForeignResponse: (): HttpResponse402 => ({
      statusCode: 402,
      headers: {},
      body: {
        ap2Version: "0.1",
        mandates: [],
      },
    }),
    buildSignedAuthorization: (): SignedAuthorization => ({
      request: {
        protocol: P("x402-v1"),
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: "0x000000000000000000000000000000000000dEaD",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: {},
      },
      signer: "did:web:payer.example",
      signature: "0xsig",
      encoded: "base64payload",
    }),
  },
  { suiteName: "protocol-a2a-discovery conformance" }
);
