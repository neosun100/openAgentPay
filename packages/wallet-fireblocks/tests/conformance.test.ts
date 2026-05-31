/**
 * Fireblocks wallet ↔ Conformance suite — proves FireblocksConnector backed by
 * the RealFireblocksSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the EIP-712 (secp256k1) signing path is real, broadcast
 * is deferred (no `submit` hook), so all non-network conformance assertions hold.
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
  FireblocksConnector,
  MemoryInstrumentStore,
  FIREBLOCKS_PROTOCOL,
  RealFireblocksSigner,
  deriveFireblocksKeypair,
  generateNonce,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic vault identity so the suite is reproducible.
const TEST_KP = deriveFireblocksKeypair("conformance-seed", "0");

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new FireblocksConnector({
        signer: new RealFireblocksSigner({
          privateKey: TEST_KP.privateKey,
          vaultAccountId: "0",
          apiKey: "mock-fireblocks-api-key",
        }),
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `fb-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: FIREBLOCKS_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x1111111111111111111111111111111111111111",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:84532" },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: generateNonce(),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-fireblocks conformance (RealFireblocksSigner)",
  }
);
