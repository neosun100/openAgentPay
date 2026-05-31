/**
 * Cardano wallet ↔ Conformance suite — proves CardanoConnector backed by the
 * RealCardanoSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the Ed25519 signing path is real, broadcast is deferred
 * (no `submit` hook), so all non-network conformance assertions hold.
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
  CardanoConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealCardanoSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test seed so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(7);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new CardanoConnector({
        signer: new RealCardanoSigner({ seed: TEST_SEED, network: "testnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `ada-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1500000", decimals: 6, currency: "ADA" },
      recipient:
        "addr_test1vqg9ywrnxm0z4j0qf3vqj8d3p7x0kqg7h6w7n6m5l4k3j2vqe5xyz",
      asset: { symbol: "ADA", decimals: 6 },
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
    suiteName: "wallet-cardano conformance (RealCardanoSigner)",
  }
);
