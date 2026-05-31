/**
 * Mantle wallet ↔ Conformance suite — proves MantleSepoliaConnector passes the
 * canonical 25-test WalletConnector contract.
 *
 * Runs the full crypto path (real viem EIP-712 signing) offline; balance reads
 * are resilient (fall back to zero on a placeholder USDC) and broadcast is
 * gated behind OPENAGENTPAY_LIVE_TESTS, so all non-network assertions hold and
 * the LIVE run additionally exercises the RPC-backed read path.
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
  MantleSepoliaConnector,
  MemoryInstrumentStore,
  MANTLE_PROTOCOL,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test key so the suite is reproducible.
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new MantleSepoliaConnector({
        privateKey: TEST_PRIVATE_KEY,
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `mantle-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: MANTLE_PROTOCOL,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:5003" },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "ab".repeat(32),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-mantle conformance (MantleSepoliaConnector)",
  }
);
