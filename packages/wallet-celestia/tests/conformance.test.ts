/**
 * Celestia wallet ↔ Conformance suite — proves CelestiaConnector backed by the
 * RealCelestiaSigner passes the canonical 25-test WalletConnector contract.
 *
 * Runs fully offline: the secp256k1 signing path is real, broadcast is
 * deferred (no `submit` hook), so all non-network conformance assertions hold.
 * Network-gated tests run only when OPENAGENTPAY_LIVE_TESTS=true.
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
  CelestiaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealCelestiaSigner,
} from "../src/index.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) =>
    expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

// Deterministic test mnemonic (24 words) so the suite is reproducible.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new CelestiaConnector({
        signer: new RealCelestiaSigner({
          mnemonic: TEST_MNEMONIC,
          chainId: "mocha-4",
        }),
        instrumentStore: new MemoryInstrumentStore(),
        chainId: "mocha-4",
      }),
    createUserId: (suffix) => `celestia-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "TIA" },
      recipient: "celestia1qv9pzxqlyckngw6zf9g9whn9d3eh4qvgqag6fl",
      asset: { symbol: "TIA", decimals: 6 },
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
    suiteName: "wallet-celestia conformance (RealCelestiaSigner)",
  }
);
