/**
 * Magic.link wallet ↔ Conformance suite — proves MagicConnector backed by the
 * RealMagicSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 EIP-712 signing path is real, broadcast is
 * deferred (no `submit` hook). Network-gated tests run only under
 * OPENAGENTPAY_LIVE_TESTS=true and still exercise the real sign path; settle()
 * reports a canonical errorCode (rpc_error) in the offline-safe default, which
 * the conformance suite accepts.
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
  MagicConnector,
  MemoryInstrumentStore,
  RealMagicSigner,
  MAGIC_PROTOCOL,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic throwaway key so the suite is reproducible (NEVER real funds).
const TEST_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TEST_EMAIL = "conformance@openagentpay.dev";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new MagicConnector({
        agentEmail: TEST_EMAIL,
        signer: new RealMagicSigner({ email: TEST_EMAIL, privateKey: TEST_PK }),
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `magic-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: MAGIC_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; only runs when OPENAGENTPAY_LIVE_TESTS=true
    skipSettle: false,
    suiteName: "wallet-magic conformance (RealMagicSigner)",
  }
);
