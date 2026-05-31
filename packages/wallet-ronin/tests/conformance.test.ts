/**
 * Ronin wallet ↔ Conformance suite — proves RoninSaigonConnector passes the
 * canonical `runWalletConformance()` 25-test contract.
 *
 * Runs fully offline: the EIP-712 signing + ecrecover verification path is
 * real (viem PrivateKeyAccount.signTypedData), the token name is resolved
 * offline via the stub, and settle() uses the default MockBroadcaster — so all
 * non-network conformance assertions hold without RPC. Under
 * OPENAGENTPAY_LIVE_TESTS=true the same suite runs (network-gated tests too).
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  runWalletConformance,
  type TestRunner,
} from "@openagentpay/conformance";
import type { PaymentRequest, UserId } from "@openagentpay/core";
import {
  RoninSaigonConnector,
  RONIN_PROTOCOL,
  MemoryInstrumentStore,
} from "../src/connector.js";
import { RoninTokenClient } from "../src/token-client.js";

// Throwaway deterministic test private key (NEVER use for real funds).
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_TOKEN = "0x067FBFf8990c58Ab90BaE3c97241C5d736053F77" as const;

function makeStubTokenClient(): RoninTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 2021, name: "Ronin Saigon Testnet" },
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USD Coin"),
    getBalance: vi.fn(async () => 1_000_000_000n), // 1000 USDC
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    // Real signing delegates to the prototype method (bound below).
    signTransferAuthorization: RoninTokenClient.prototype.signTransferAuthorization,
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  // Bind the real signing impl to the stub so `this.chain` / `this.domainVersion`
  // resolve against the stub's fields (chainId 2021, version "2").
  (stub as { domainVersion?: string }).domainVersion = "2";
  stub.signTransferAuthorization = stub.signTransferAuthorization.bind(stub);
  return stub as unknown as RoninTokenClient;
}

const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as ReturnType<TestRunner["expect"]>,
};

runWalletConformance(
  runner,
  {
    createConnector: () =>
      new RoninSaigonConnector({
        privateKey: TEST_PRIVATE_KEY,
        tokenAddress: TEST_TOKEN,
        instrumentStore: new MemoryInstrumentStore(),
        tokenClient: makeStubTokenClient(),
      }),
    createUserId: (suffix) => `ronin-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: RONIN_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:2021", contract: TEST_TOKEN },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; offline signing still exercises sign path under LIVE
    skipSettle: false,
    suiteName: "wallet-ronin conformance (RoninSaigonConnector)",
  }
);
