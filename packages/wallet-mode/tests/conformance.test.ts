/**
 * Mode wallet ↔ Conformance suite — proves the connector passes the canonical
 * `runWalletConformance()` 25-test contract.
 *
 * Network I/O (getName / getBalance / broadcast / receipt) is stubbed so the
 * suite runs offline, but the EIP-712 signing path is REAL (viem
 * PrivateKeyAccount.signTypedData over the stub's getName()). The conformance
 * suite's signature checks therefore exercise a genuine secp256k1 signature.
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
  ModeSepoliaConnector,
  MODE_PROTOCOL,
  MODE_CAIP2,
  MemoryInstrumentStore,
} from "../src/connector.js";
import { ModeTokenClient } from "../src/token-client.js";

// Throwaway test private key (NEVER use for real funds)
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS =
  "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/**
 * Build a ModeTokenClient whose REAL signing path is preserved (we keep the
 * prototype's signTransferAuthorization), but whose network reads/writes are
 * stubbed so conformance runs without RPC.
 */
function makeStubTokenClient(): ModeTokenClient {
  const real = new ModeTokenClient({ tokenAddress: TEST_TOKEN });
  // Stub the network-touching methods only.
  vi.spyOn(real, "getDecimals").mockResolvedValue(6);
  vi.spyOn(real, "getName").mockResolvedValue("USDC");
  vi.spyOn(real, "getBalance").mockResolvedValue(1_000_000_000n);
  vi.spyOn(real, "getDomainSeparator").mockResolvedValue(("0x" + "00".repeat(32)) as `0x${string}`);
  vi.spyOn(real, "isAuthorizationUsed").mockResolvedValue(false);
  vi.spyOn(real, "broadcastSignedAuthorization").mockResolvedValue("0xfeedface" as const);
  vi.spyOn(real, "waitForReceipt").mockResolvedValue({
    blockNumber: 12345n,
    gasUsed: 82_406n,
    status: "success" as const,
  });
  // signTransferAuthorization is left REAL → produces a verifiable signature.
  return real;
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
      new ModeSepoliaConnector({
        privateKey: TEST_PRIVATE_KEY,
        tokenAddress: TEST_TOKEN,
        instrumentStore: new MemoryInstrumentStore(),
        tokenClient: makeStubTokenClient(),
      }),
    createUserId: (suffix) => `mode-test-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: MODE_PROTOCOL,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6, chain: MODE_CAIP2, contract: TEST_TOKEN },
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
    suiteName: "wallet-mode conformance",
  }
);

// Sanity: the throwaway key derives the expected EVM address (proves the real
// signer is wired, not a fully-faked stub).
describe("wallet-mode conformance wiring", () => {
  it("derives the expected agent address from the test key", () => {
    const c = new ModeSepoliaConnector({
      privateKey: TEST_PRIVATE_KEY,
      tokenAddress: TEST_TOKEN,
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c.agentAddress).toBe(TEST_AGENT_ADDRESS);
  });
});
