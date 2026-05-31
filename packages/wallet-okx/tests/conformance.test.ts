/**
 * OKX Pay wallet ↔ Conformance suite — proves OkxPayConnector backed by the
 * RealOkxSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: HMAC-SHA256 signing is real, broadcast is deferred (no
 * `submit` hook → deterministic mock receipt), so all assertions hold.
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
  OkxPayConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test credential so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(11);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new OkxPayConnector({
        seed: TEST_SEED,
        instrumentStore: new MemoryInstrumentStore(),
        balanceAtomic: "5000000",
        network: "okx-pay-sandbox",
      }),
    createUserId: (suffix) => `okx-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
      recipient: "oap-sub-conformance",
      asset: { symbol: "USDT", decimals: 6 },
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
    suiteName: "wallet-okx conformance (RealOkxSigner)",
  }
);
