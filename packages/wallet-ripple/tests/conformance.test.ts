/**
 * Ripple wallet ↔ Conformance suite — proves RippleConnector backed by the
 * RealRippleSigner passes the canonical 25-test WalletConnector contract.
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
  RippleConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealRippleSigner,
  generateRippleKeypair,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test keypair so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(5);

// A real, valid "r..." recipient generated from a fixed seed.
const RECIPIENT = generateRippleKeypair().address;

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new RippleConnector({
        signer: new RealRippleSigner({ seed: TEST_SEED, network: "testnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `xrp-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "XRP" },
      recipient: RECIPIENT,
      asset: { symbol: "XRP", decimals: 6 },
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
    suiteName: "wallet-ripple conformance (RealRippleSigner)",
  }
);
