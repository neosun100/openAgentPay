/**
 * Sonic wallet ↔ Conformance suite — proves SonicConnector passes the canonical
 * 25-test WalletConnector contract.
 *
 * Runs fully offline: the EIP-712 signing path is real (viem PrivateKeyAccount),
 * balance reads are served by a stub token client, and settle() uses the
 * offline-safe mock broadcaster. All 25 non-network + network assertions hold
 * with or without OPENAGENTPAY_LIVE_TESTS.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  runWalletConformance,
  type TestRunner,
} from "@openagentpay/conformance";
import type { PaymentRequest, UserId } from "@openagentpay/core";
import { type Hex } from "viem";
import {
  SonicConnector,
  SONIC_PROTOCOL,
  MemoryInstrumentStore,
} from "../src/index.js";
import { SonicTokenClient } from "../src/token-client.js";

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

const TEST_TOKEN = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" as Hex;

// Offline-safe stub token client: real signing/verify, stubbed network reads.
function makeStubTokenClient(): SonicTokenClient {
  const real = new SonicTokenClient({
    tokenAddress: TEST_TOKEN,
    domainName: "USD Coin",
  });
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: real.chain,
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: real.getName.bind(real),
    getBalance: vi.fn(async () => 1_000_000_000n),
    getDomainSeparator: vi.fn(async () => ("0x" + "00".repeat(32)) as Hex),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization: real.signTransferAuthorization.bind(real),
    verifySignedAuthorization: real.verifySignedAuthorization.bind(real),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as Hex),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 1n,
      gasUsed: 1n,
      status: "success" as const,
    })),
  };
  return stub as unknown as SonicTokenClient;
}

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new SonicConnector({
        // Deterministic test key (viem vector 0x..01) so the suite is reproducible.
        privateKey:
          "0x0000000000000000000000000000000000000000000000000000000000000001",
        tokenAddress: TEST_TOKEN,
        instrumentStore: new MemoryInstrumentStore(),
        broadcast: "mock",
        tokenClient: makeStubTokenClient(),
      }),
    createUserId: (suffix) => `sonic-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: SONIC_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:57054", contract: TEST_TOKEN },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "cd".repeat(32),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-sonic conformance (SonicConnector)",
  }
);
