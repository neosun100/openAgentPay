/**
 * Circle wallet ↔ Conformance suite — proves CircleConnector (developer-
 * controlled, RealCircleSigner) passes the canonical 25-test WalletConnector
 * contract.
 *
 * Runs fully offline: keypair derivation + EIP-712 signing are real; broadcast
 * is the deterministic mock path (no `submit` hook), so all sign + settle
 * conformance assertions hold under OPENAGENTPAY_LIVE_TESTS=true.
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
  CircleConnector,
  MemoryInstrumentStore,
  CIRCLE_PROTOCOL,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test entity secret so the suite is reproducible.
const TEST_ENTITY_SECRET =
  "3333333333333333333333333333333333333333333333333333333333333333";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new CircleConnector({
        apiKey: "mock-circle-api-key",
        entitySecret: TEST_ENTITY_SECRET,
        walletSalt: "conformance-wallet-set",
        network: "base-sepolia",
        gasStation: true,
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `circle-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: CIRCLE_PROTOCOL,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign+settle under LIVE
    skipSettle: false,
    suiteName: "wallet-circle conformance (RealCircleSigner, developer-controlled)",
  }
);
