/**
 * Starknet wallet ↔ Conformance suite — proves StarknetConnector backed by the
 * RealStarknetSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real, broadcast is deferred
 * (no `submit` hook), so all non-network conformance assertions hold. The 4
 * settle tests are gated behind requiresNetwork:true but the it-cases stay
 * defined and pass in both offline and LIVE modes.
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
  StarknetConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealStarknetSigner,
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
      new StarknetConnector({
        signer: new RealStarknetSigner({
          privateKey: TEST_PRIV,
          network: "sepolia",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        network: "sepolia",
      }),
    createUserId: (suffix) => `stark-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      recipient:
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
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
    suiteName: "wallet-starknet conformance (RealStarknetSigner)",
  }
);
