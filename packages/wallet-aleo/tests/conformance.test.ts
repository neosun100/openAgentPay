/**
 * Aleo wallet ↔ Conformance suite — proves AleoConnector backed by the
 * RealAleoSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the ed25519 signing path is real, broadcast is deferred
 * (no `submit` hook), so all non-network conformance assertions hold. The 4
 * settle tests are gated behind requiresNetwork:true (still exercised under
 * OPENAGENTPAY_LIVE_TESTS=true).
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
  AleoConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealAleoSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test private key so the suite is reproducible.
const TEST_PRIV = new Uint8Array(32).fill(7);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new AleoConnector({
        signer: new RealAleoSigner({
          privateKey: TEST_PRIV,
          network: "testnet",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `aleo-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "ALEO" },
      recipient: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
      asset: { symbol: "ALEO", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "REF_CONFORMANCE",
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // settle gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-aleo conformance (RealAleoSigner)",
  }
);
