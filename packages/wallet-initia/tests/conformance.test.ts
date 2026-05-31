/**
 * Initia wallet ↔ Conformance suite — proves InitiaConnector backed by the
 * RealInitiaSigner passes the canonical 25-test WalletConnector contract.
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
  InitiaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealInitiaSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test mnemonic so the suite is reproducible.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new InitiaConnector({
        signer: new RealInitiaSigner({
          mnemonic: TEST_MNEMONIC,
          chainId: "initiation-2",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        chainId: "initiation-2",
      }),
    createUserId: (suffix) => `init-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "init1qy352eufqy352eufqy352eufqy35qqqz9w3z9w",
      asset: { symbol: "USDC", decimals: 6 },
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
    suiteName: "wallet-initia conformance (RealInitiaSigner)",
  }
);
