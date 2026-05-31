/**
 * Dogecoin wallet ↔ Conformance suite — proves DogecoinConnector backed by the
 * RealDogecoinSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real, broadcast is deferred
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
  DogecoinConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealDogecoinSigner,
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
      new DogecoinConnector({
        signer: new RealDogecoinSigner({
          privateKey: TEST_PRIV,
          network: "testnet",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `doge-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "100000000", decimals: 8, currency: "DOGE" }, // 1 DOGE
      recipient: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
      asset: { symbol: "DOGE", decimals: 8 },
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
    suiteName: "wallet-dogecoin conformance (RealDogecoinSigner)",
  }
);
