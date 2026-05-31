/**
 * Solana wallet ↔ Conformance suite — proves SolanaConnector backed by the
 * RealSolanaSigner passes the canonical 25-test WalletConnector contract.
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
  SolanaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealSolanaSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test keypair so the suite is reproducible.
const TEST_SEED = new Uint8Array(32).fill(3);

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new SolanaConnector({
        signer: new RealSolanaSigner({ seed: TEST_SEED, cluster: "devnet" }),
        instrumentStore: new MemoryInstrumentStore(),
        cluster: "devnet",
      }),
    createUserId: (suffix) => `sol-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "9aLzC5J9pvwPCzJ8aB3uDk5vTd23N7TTczbT8X4Hk6QH",
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
    suiteName: "wallet-solana conformance (RealSolanaSigner)",
  }
);
