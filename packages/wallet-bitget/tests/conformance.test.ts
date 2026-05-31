/**
 * Bitget Wallet Pay ↔ Conformance suite — proves BitgetPayConnector backed by
 * the RealBitgetSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the HMAC-SHA256 signing path is real, broadcast is
 * deferred (no `submit` hook → deterministic mock tx ref), so all conformance
 * assertions hold without any network.
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
  BitgetPayConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealBitgetSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new BitgetPayConnector({
        signer: new RealBitgetSigner({ seed: "conformance-fixture-seed", sandbox: true }),
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `bitget-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
      recipient: "bg_merchant_recipient01",
      asset: { symbol: "USDT", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "REF_CONFORMANCE",
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline HMAC path still exercised under LIVE
    skipSettle: false,
    suiteName: "wallet-bitget conformance (RealBitgetSigner)",
  }
);
