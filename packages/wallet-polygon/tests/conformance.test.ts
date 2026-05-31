/**
 * Polygon Amoy wallet ↔ Conformance suite — proves the connector passes the
 * canonical `runWalletConformance()` 25-test contract.
 *
 * Uses a stubbed token-client (no real RPC) but the EIP-712 signing path is
 * real (viem PrivateKeyAccount).
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { runWalletConformance, type TestRunner } from "@openagentpay/conformance";
import type { PaymentRequest, UserId } from "@openagentpay/core";
import {
  PolygonAmoyConnector,
  POLYGON_PROTOCOL,
  MemoryInstrumentStore,
} from "../src/connector.js";
import { PolygonAmoyTokenClient } from "../src/token-client.js";

// Throwaway test private key (NEVER use for real funds)
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" as const;

function makeStubTokenClient(): PolygonAmoyTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 80002, name: "Polygon Amoy" },
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USDC"),
    getBalance: vi.fn(async () => 1_000_000_000n),
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    // Real EIP-712 signing happens in the connector via the agent account; the
    // stub is only consulted for getName() during signing. We still provide a
    // signTransferAuthorization mock so settle() has a wire payload.
    signTransferAuthorization: vi.fn(async () => ({
      authorization: {
        from: TEST_AGENT_ADDRESS as never,
        to: "0x000000000000000000000000000000000000dEaD" as never,
        value: "1000",
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: ("0x" + "0".repeat(64)) as never,
      },
      signature: "0xdeadbeef" as never,
      v: 27,
      r: ("0x" + "00".repeat(32)) as never,
      s: ("0x" + "00".repeat(32)) as never,
      chainId: 80002,
      verifyingContract: TEST_TOKEN as never,
    })),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as PolygonAmoyTokenClient;
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
      new PolygonAmoyConnector({
        privateKey: TEST_PRIVATE_KEY,
        tokenAddress: TEST_TOKEN,
        instrumentStore: new MemoryInstrumentStore(),
        tokenClient: makeStubTokenClient(),
      }),
    createUserId: (suffix) => `polygon-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: POLYGON_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "1".repeat(64),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: true, // gated; only runs when OPENAGENTPAY_LIVE_TESTS=true
    skipSettle: false,
    suiteName: "wallet-polygon conformance",
  }
);
