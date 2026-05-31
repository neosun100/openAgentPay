/**
 * Scroll Sepolia wallet ↔ Conformance suite — proves ScrollSepoliaConnector
 * passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the EIP-712 signing path is real (in-process viem
 * PrivateKeyAccount), settle()'s broadcast is the only network step and is
 * gated behind requiresNetwork:true so the offline suite skips it.
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
  ScrollSepoliaConnector,
  MemoryInstrumentStore,
  SCROLL_PROTOCOL,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test key so the suite is reproducible (vanity key #1).
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new ScrollSepoliaConnector({
        privateKey: TEST_PRIVATE_KEY,
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `scroll-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: SCROLL_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0xaAa86bb77B5a14B23E5724fb12E4685809599F23",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:534351" },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "cd".repeat(32),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-scroll conformance (ScrollSepoliaConnector)",
  }
);
