/**
 * Injective wallet ↔ Conformance suite — proves InjectiveConnector backed by
 * the RealInjectiveSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the Ethermint secp256k1 signing path is real, broadcast
 * is deferred (no `submit` hook), so all non-network conformance assertions
 * hold. Network-gated tests run only under OPENAGENTPAY_LIVE_TESTS=true.
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
  InjectiveConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealInjectiveSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test mnemonic so the suite is reproducible.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new InjectiveConnector({
        signer: new RealInjectiveSigner({
          mnemonic: TEST_MNEMONIC,
          chainId: "injective-888", // testnet
        }),
        instrumentStore: new MemoryInstrumentStore(),
        chainId: "injective-888",
      }),
    createUserId: (suffix) => `inj-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000000000000000", decimals: 18, currency: "INJ" },
      recipient: "inj1qy352eufqy352eufqy352eufqy352euny6h2gt",
      asset: { symbol: "INJ", decimals: 18 },
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
    suiteName: "wallet-injective conformance (RealInjectiveSigner)",
  }
);
