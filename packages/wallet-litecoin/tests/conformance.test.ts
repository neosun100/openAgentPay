/**
 * Litecoin wallet ↔ Conformance suite — proves LitecoinConnector backed by the
 * RealLitecoinSigner passes the canonical 25-test WalletConnector contract.
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
  LitecoinConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealLitecoinSigner,
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
      new LitecoinConnector({
        signer: new RealLitecoinSigner({ privateKey: TEST_PRIV, network: "testnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `ltc-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "100000", decimals: 8, currency: "LTC" }, // 0.001 LTC
      recipient: "tltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kw9d3djl",
      asset: { symbol: "LTC", decimals: 8 },
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
    suiteName: "wallet-litecoin conformance (RealLitecoinSigner)",
  }
);
