/**
 * Tezos wallet ↔ Conformance suite — proves TezosConnector backed by the
 * RealTezosSigner passes the canonical 25-test WalletConnector contract.
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
  TezosConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealTezosSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test seed so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(7);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new TezosConnector({
        signer: new RealTezosSigner({ seed: TEST_SEED, network: "ghostnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "ghostnet",
      }),
    createUserId: (suffix) => `tez-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1500000", decimals: 6, currency: "XTZ" },
      recipient: "tz1burnburnburnburnburnburnburjAYjjX", // valid tz1 (Tezos burn address)
      asset: { symbol: "XTZ", decimals: 6, chain: "tezos:mainnet" },
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
    suiteName: "wallet-tezos conformance (RealTezosSigner)",
  }
);
