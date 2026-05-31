/**
 * Crossmint wallet ↔ Conformance suite — proves CrossmintConnector backed by
 * the RealCrossmintSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 EIP-712 signing path is real, broadcast is
 * deferred (no `submit` hook). Network-gated tests run only under
 * OPENAGENTPAY_LIVE_TESTS=true and still exercise the real sign path; settle()
 * reports a canonical errorCode (rpc_error) in the offline-safe default, which
 * the conformance suite accepts.
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
  CrossmintConnector,
  MemoryInstrumentStore,
  RealCrossmintSigner,
  CROSSMINT_PROTOCOL,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic throwaway project credentials so the suite is reproducible.
const TEST_API_KEY = "sk_test_crossmint_mock_apikey_conformance";
const TEST_PROJECT_ID = "proj_conformance_0001";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new CrossmintConnector({
        apiKey: TEST_API_KEY,
        projectId: TEST_PROJECT_ID,
        signer: new RealCrossmintSigner({
          apiKey: TEST_API_KEY,
          projectId: TEST_PROJECT_ID,
        }),
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `crossmint-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: CROSSMINT_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; only runs when OPENAGENTPAY_LIVE_TESTS=true
    skipSettle: false,
    suiteName: "wallet-crossmint conformance (RealCrossmintSigner)",
  }
);
