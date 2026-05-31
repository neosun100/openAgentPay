/**
 * Stripe Privy wallet ↔ Conformance suite — proves StripePrivyConnector passes
 * the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the EIP-712 secp256k1 signing path is real, broadcast is
 * the deterministic offline mock (no `submit` hook), so all non-network
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
  StripePrivyConnector,
  MemoryInstrumentStore,
  STRIPE_PRIVY_PROTOCOL,
} from "../src/index.js";

// Deterministic throwaway key so the suite is reproducible (NEVER real funds).
const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new StripePrivyConnector({
        privy: {
          appId: "privy-app-mock-oap",
          appSecret: "privy-secret-mock-do-not-commit",
          privateKey: TEST_PRIVATE_KEY,
        },
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `sp-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: STRIPE_PRIVY_PROTOCOL,
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
    requiresNetwork: true, // gated; offline signing+settle still exercised under LIVE
    skipSettle: false,
    suiteName: "wallet-stripe-privy conformance (managed embedded wallet)",
  }
);
