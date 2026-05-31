/**
 * Berachain mainnet wallet ↔ Conformance suite — proves
 * BerachainMainnetConnector passes the canonical 25-test WalletConnector
 * contract.
 *
 * Runs fully offline: the EIP-712 signing path is real (the domain `name` is
 * supplied locally, so no chain I/O), broadcast is deferred. All non-network
 * conformance assertions hold; settle/balance are gated behind requiresNetwork.
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
  BerachainMainnetConnector,
  MemoryInstrumentStore,
  BERA_PROTOCOL,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test private key so the suite is reproducible.
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new BerachainMainnetConnector({
        privateKey: TEST_PRIVATE_KEY,
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `bera-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: BERA_PROTOCOL,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
      asset: { symbol: "USDC", decimals: 6 },
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
    suiteName: "wallet-berachain-mainnet conformance (EIP-3009)",
  }
);
