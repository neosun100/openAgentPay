/**
 * Conformance: BybitPayConnector ↔ the canonical 25-test WalletConnector suite.
 *
 * Runs fully offline — the HMAC-SHA256 signing path is real, broadcast is the
 * default deterministic offline submit hook, so all assertions (including
 * settle) hold without network. Gated via requiresNetwork:true.
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
  BybitPayConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  keypairFromSecret,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic credential so the suite is reproducible.
const TEST_CREDENTIAL = keypairFromSecret("conformance-seed");

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new BybitPayConnector({
        credential: TEST_CREDENTIAL,
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `bybit-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
      recipient: "bybit-merchant-9001",
      asset: { symbol: "USDT", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0xCONFORMANCE",
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing+settle still exercised under LIVE
    skipSettle: false,
    suiteName: "wallet-bybit conformance (RealBybitSigner, HMAC-SHA256)",
  }
);
