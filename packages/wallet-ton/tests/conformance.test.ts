/**
 * TON wallet ↔ Conformance suite — proves TonConnector backed by the
 * RealTonSigner passes the canonical 25-test WalletConnector contract.
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
import type { PaymentRequest, ProtocolId, UserId } from "@openagentpay/core";
import {
  TonConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealTonSigner,
  generateTonKeypair,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test keypair so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(7);

// A real, valid recipient address derived in-process.
const RECIPIENT = generateTonKeypair({ testOnly: true }).address;

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new TonConnector({
        signer: new RealTonSigner({ seed: TEST_SEED, network: "testnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `ton-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
      recipient: RECIPIENT,
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
    suiteName: "wallet-ton conformance (RealTonSigner)",
  }
);
