/**
 * Fuel wallet ↔ Conformance suite — proves FuelConnector backed by the
 * RealFuelSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real, broadcast is deferred
 * (no `submit` hook), so all non-network conformance assertions hold. The
 * 4 settle-group / network-gated cases stay DEFINED in both modes and execute
 * under OPENAGENTPAY_LIVE_TESTS=true.
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
  FuelConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealFuelSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test private key so the suite is reproducible.
const TEST_PRIV = new Uint8Array(32).fill(9);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new FuelConnector({
        signer: new RealFuelSigner({
          privateKey: TEST_PRIV,
          network: "testnet",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `fuel-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000000", decimals: 9, currency: "ETH" },
      recipient:
        "0x2c8e117bcf3a7088e646316243fb364fbd365d5b6c6f3a7a8b9c0d1e2f3a4b5c",
      asset: { symbol: "ETH", decimals: 9 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "REF_CONFORMANCE",
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gates the 4 settle/network cases offline; defined in both modes
    skipSettle: false,
    suiteName: "wallet-fuel conformance (RealFuelSigner)",
  }
);
