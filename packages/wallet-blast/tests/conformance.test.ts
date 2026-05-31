/**
 * Blast wallet ↔ Conformance suite — proves the connector passes the canonical
 * `runWalletConformance()` 25-test contract.
 *
 * Uses a stubbed token-client (no real RPC) but the EIP-712 signing path is
 * real (viem PrivateKeyAccount.signTypedData over the stub's getName()).
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  runWalletConformance,
  type TestRunner,
} from "@openagentpay/conformance";
import type {
  PaymentRequest,
  UserId,
} from "@openagentpay/core";
import {
  BlastSepoliaConnector,
  BLAST_PROTOCOL,
  MemoryInstrumentStore,
} from "../src/connector.js";
import { BlastTokenClient } from "../src/token-client.js";

// Throwaway test private key (NEVER use for real funds)
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS =
  "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x4300000000000000000000000000000000000003" as const;

function makeStubTokenClient(): BlastTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 168587773, name: "Blast Sepolia" },
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USDC"),
    getBalance: vi.fn(async () => 1_000_000_000n),
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
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
      chainId: 168587773,
      verifyingContract: TEST_TOKEN as never,
    })),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as BlastTokenClient;
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
      new BlastSepoliaConnector({
        privateKey: TEST_PRIVATE_KEY,
        tokenAddress: TEST_TOKEN,
        instrumentStore: new MemoryInstrumentStore(),
        tokenClient: makeStubTokenClient(),
      }),
    createUserId: (suffix) => `blast-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: BLAST_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:168587773", contract: TEST_TOKEN },
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
    suiteName: "wallet-blast conformance",
  }
);
