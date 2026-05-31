/**
 * Flow wallet ↔ Conformance suite — proves FlowConnector backed by the
 * RealFlowSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real, broadcast is
 * deferred (no `submit` hook), so all non-network conformance assertions hold.
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
  FlowConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealFlowSigner,
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
      new FlowConnector({
        signer: new RealFlowSigner({ privateKey: TEST_PRIV, network: "testnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `flow-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "100000000", decimals: 8, currency: "FLOW" },
      recipient: "0x1cf0e2f2f715450c",
      asset: { symbol: "FLOW", decimals: 8 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "FLOW_REF_CONFORMANCE",
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises the sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-flow conformance (RealFlowSigner)",
  }
);
