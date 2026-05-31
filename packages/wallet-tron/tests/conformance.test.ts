/**
 * TRON wallet ↔ Conformance suite — proves TronConnector backed by the
 * RealTronSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real, broadcast is deferred
 * (no `submit` hook), so all non-network conformance assertions hold. Network
 * tests are gated behind OPENAGENTPAY_LIVE_TESTS=true.
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
  TronConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealTronSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test private key so the suite is reproducible.
const TEST_PRIVKEY = "0".repeat(63) + "1"; // valid 32-byte scalar (= 1)

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new TronConnector({
        signer: new RealTronSigner({
          privateKeyHex: TEST_PRIVKEY,
          network: "nile",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "nile",
      }),
    createUserId: (suffix) => `tron-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
      recipient: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
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
    suiteName: "wallet-tron conformance (RealTronSigner)",
  }
);
