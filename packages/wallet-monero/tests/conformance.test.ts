/**
 * Monero wallet ↔ Conformance suite — proves MoneroConnector backed by the
 * RealMoneroSigner passes the canonical 25-test WalletConnector contract.
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
  MoneroConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealMoneroSigner,
  generateMoneroKeypair,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test keypair so the suite is reproducible.
const TEST_SPEND = new Uint8Array(32).fill(7);
const TEST_VIEW = new Uint8Array(32).fill(11);

// A second, distinct testnet address to use as the recipient.
const RECIPIENT = generateMoneroKeypair("testnet").address;

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new MoneroConnector({
        signer: new RealMoneroSigner({
          spendSecret: TEST_SPEND,
          viewSecret: TEST_VIEW,
          network: "testnet",
        }),
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `xmr-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "500000000000", decimals: 12, currency: "XMR" }, // 0.5 XMR
      recipient: RECIPIENT,
      asset: { symbol: "XMR", decimals: 12 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0000000000000000",
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-monero conformance (RealMoneroSigner)",
  }
);
