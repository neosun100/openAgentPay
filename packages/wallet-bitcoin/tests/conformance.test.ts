/**
 * Bitcoin wallet ↔ Conformance suite — proves BitcoinConnector backed by the
 * RealBitcoinSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real (DER-encoded,
 * verifiable), broadcast is deferred (no `submit` hook), so all non-network
 * conformance assertions hold; network-gated ones run only under
 * OPENAGENTPAY_LIVE_TESTS=true.
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
  BitcoinConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealBitcoinSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test private key so the suite is reproducible.
const TEST_PRIV = new Uint8Array(32).fill(7);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new BitcoinConnector({
        signer: new RealBitcoinSigner({ privateKey: TEST_PRIV, network: "testnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `btc-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "100000", decimals: 8, currency: "BTC" }, // 0.001 BTC
      recipient: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      asset: { symbol: "BTC", decimals: 8 },
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
    suiteName: "wallet-bitcoin conformance (RealBitcoinSigner)",
  }
);
