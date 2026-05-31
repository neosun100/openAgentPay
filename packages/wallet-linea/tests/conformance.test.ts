/**
 * Linea wallet ↔ Conformance suite — proves the connector passes the canonical
 * `runWalletConformance()` 25-test contract.
 *
 * Uses the connector's default offline-safe token client (real EIP-712 signing,
 * mock balance + mock broadcast), so no real RPC is required.
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
  LineaConnector,
  LINEA_PROTOCOL,
  MemoryInstrumentStore,
} from "../src/connector.js";

// Throwaway test private key (NEVER use for real funds)
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new LineaConnector({
        privateKey: TEST_PRIVATE_KEY,
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `linea-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: LINEA_PROTOCOL,
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
    suiteName: "wallet-linea conformance",
  }
);
