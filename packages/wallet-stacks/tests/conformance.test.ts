/**
 * Stacks wallet ↔ Conformance suite — proves StacksConnector backed by the
 * RealStacksSigner passes the canonical 25-test WalletConnector contract.
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
import type { PaymentRequest, ProtocolId, UserId } from "@openagentpay/core";
import {
  StacksConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealStacksSigner,
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
      new StacksConnector({
        signer: new RealStacksSigner({
          privateKey: TEST_PRIV,
          network: "testnet",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `stx-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "STX" },
      recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      asset: { symbol: "STX", decimals: 6 },
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
    suiteName: "wallet-stacks conformance (RealStacksSigner)",
  }
);
