/**
 * Kaspa wallet ↔ Conformance suite — proves KaspaConnector backed by the
 * RealKaspaSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real, broadcast is deferred
 * (no `submit` hook), so all non-network conformance assertions hold; the
 * network-gated cases run under OPENAGENTPAY_LIVE_TESTS=true.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  runWalletConformance,
  type TestRunner,
} from "@openagentpay/conformance";
import type { PaymentRequest, UserId } from "@openagentpay/core";
import {
  KaspaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealKaspaSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test mnemonic so the suite is reproducible.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new KaspaConnector({
        signer: new RealKaspaSigner({
          mnemonic: TEST_MNEMONIC,
          network: "testnet-10",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet-10",
      }),
    createUserId: (suffix) => `kaspa-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "100000000", decimals: 8, currency: "KAS" },
      recipient:
        "kaspatest:qqkqkz7n3p8d3p8d3p8d3p8d3p8d3p8d3p8d3p8d3p8d3p8d3p8dummy",
      asset: { symbol: "KAS", decimals: 8 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "REF_CONFORMANCE",
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-kaspa conformance (RealKaspaSigner)",
  }
);
