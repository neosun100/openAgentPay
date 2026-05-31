/**
 * Polkadot wallet ↔ Conformance suite — proves PolkadotConnector backed by the
 * RealPolkadotSigner passes the canonical 25-test WalletConnector contract.
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
import type { PaymentRequest, ProtocolId, UserId } from "@openagentpay/core";
import {
  PolkadotConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealPolkadotSigner,
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
      new PolkadotConnector({
        signer: new RealPolkadotSigner({ seed: TEST_SEED, network: "westend" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "westend",
      }),
    createUserId: (suffix) => `dot-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "10000000000", decimals: 10, currency: "DOT" },
      // Well-known Substrate dev address (Bob) — valid SS58.
      recipient: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
      asset: { symbol: "DOT", decimals: 10 },
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
    suiteName: "wallet-polkadot conformance (RealPolkadotSigner)",
  }
);
