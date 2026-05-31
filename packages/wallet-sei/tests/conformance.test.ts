/**
 * Sei wallet ↔ Conformance suite — proves SeiConnector backed by the
 * RealSeiSigner passes the canonical 25-test WalletConnector contract.
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
  SeiConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealSeiSigner,
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

// A valid sei1… recipient (derived offline from a second deterministic
// mnemonic; distinct from the signer's own address).
const RECIPIENT = "sei15f7sdzduxh5umchk433z275xz8gnw8lq9qsqvu";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new SeiConnector({
        signer: new RealSeiSigner({
          mnemonic: TEST_MNEMONIC,
          chainId: "atlantic-2",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        chainId: "atlantic-2",
      }),
    createUserId: (suffix) => `sei-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "SEI" },
      recipient: RECIPIENT,
      asset: { symbol: "SEI", decimals: 6 },
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
    suiteName: "wallet-sei conformance (RealSeiSigner)",
  }
);
