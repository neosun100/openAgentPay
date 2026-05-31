/**
 * Aptos wallet ↔ Conformance suite — proves AptosConnector backed by the
 * RealAptosSigner passes the canonical 25-test WalletConnector contract.
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
  AptosConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealAptosSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test keypair so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(7);

// A valid 0x+64-hex Aptos recipient address (arbitrary fixture).
const RECIPIENT = "0x" + "1f".repeat(32);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new AptosConnector({
        signer: new RealAptosSigner({ seed: TEST_SEED, network: "testnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "testnet",
      }),
    createUserId: (suffix) => `aptos-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: RECIPIENT,
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
    suiteName: "wallet-aptos conformance (RealAptosSigner)",
  }
);
