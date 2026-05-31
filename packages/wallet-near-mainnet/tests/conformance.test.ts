/**
 * NEAR MAINNET wallet ↔ Conformance suite — proves NearMainnetConnector backed
 * by the RealNearMainnetSigner passes the canonical 25-test WalletConnector
 * contract.
 *
 * Runs fully offline: the Ed25519 signing path is real, broadcast is deferred
 * (no `submit` hook), so all non-network conformance assertions hold. The
 * network-gated tests run only under OPENAGENTPAY_LIVE_TESTS=true.
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
  NearMainnetConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealNearMainnetSigner,
  NEAR_DECIMALS,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test keypair so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(9);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new NearMainnetConnector({
        signer: new RealNearMainnetSigner({ seed: TEST_SEED }),
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `near-mainnet-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: NEAR_DECIMALS, currency: "NEAR" },
      recipient: "merchant.near",
      asset: { symbol: "NEAR", decimals: NEAR_DECIMALS },
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
    suiteName: "wallet-near-mainnet conformance (RealNearMainnetSigner)",
  }
);
