/**
 * ZeroDev wallet ↔ Conformance suite — proves ZeroDevConnector backed by the
 * RealZeroDevSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: owner secp256k1 signing is real, bundler broadcast is
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
  ZeroDevConnector,
  MemoryInstrumentStore,
  ZERODEV_PROTOCOL,
  RealZeroDevSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test owner key so the suite is reproducible.
const TEST_OWNER_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000003" as const;

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new ZeroDevConnector({
        signer: new RealZeroDevSigner({
          ownerPrivateKey: TEST_OWNER_KEY,
          salt: ("0x" + "00".repeat(31) + "07") as `0x${string}`,
        }),
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `zd-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: ZERODEV_PROTOCOL,
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
    requiresNetwork: true, // gated; offline signing still exercises sign+settle under LIVE
    skipSettle: false,
    suiteName: "wallet-zerodev conformance (RealZeroDevSigner)",
  }
);
