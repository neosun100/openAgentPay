/**
 * Tests for ArbitrumConnector.
 *
 * Uses real eth signing (viem PrivateKeyAccount) but mocks network I/O via a
 * stub ArbitrumTokenClient. Validates:
 *   1. signAuthorization produces a real EIP-712 signature
 *   2. createInstrument is idempotent + rejects empty userId
 *   3. getBalance proxies to token client
 *   4. settle reads txHash from a mocked broadcast
 *   5. in-process keygen when no privateKey supplied
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CreateInstrumentInput,
  type PaymentRequest,
  type ProtocolId,
  type Session,
  type SessionId,
  type SignAuthorizationInput,
  type UserId,
} from "@openagentpay/core";
import {
  ArbitrumConnector,
  ARBITRUM_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import { ArbitrumTokenClient } from "../src/token-client.js";
import { ARBITRUM_SEPOLIA_USDC, arbitrumSepoliaTestnet } from "../src/chain.js";

// Throwaway test private key (NEVER use for real funds) → known address below.
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = ARBITRUM_SEPOLIA_USDC;

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): ArbitrumTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 421614, name: "Arbitrum Sepolia" },
    publicClient: {} as never,
    // Mirror the private #domainVersion default ("2") so a prototype-bound
    // signTransferAuthorization builds a complete EIP-712 domain.
    domainVersion: "2",
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USD Coin"),
    getBalance: vi.fn(async () => 1_000_000_000n), // 1000 USDC
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization: vi.fn(),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as ArbitrumTokenClient;
}

function makeConnector(tokenClient?: ArbitrumTokenClient): ArbitrumConnector {
  return new ArbitrumConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

function buildSession(userId: UserId): Session {
  const now = new Date(FIXED_NOW_MS);
  return {
    id: `payment-session-test-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildPaymentRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: ARBITRUM_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: "0x000000000000000000000000000000000000dEaD",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0x" + "1".repeat(64),
    rawPayload: {},
    ...overrides,
  };
}

describe("ArbitrumConnector.getCapabilities", () => {
  it("reports arbitrum provider with x402-v1 protocol", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(ARBITRUM_PROTOCOL);
  });

  it("is pure (equal results on repeat calls)", () => {
    const c = makeConnector(makeStubTokenClient());
    const a = c.getCapabilities();
    const b = c.getCapabilities();
    expect(a.walletProvider).toBe(b.walletProvider);
    expect(a.supportedAssets.length).toBe(b.supportedAssets.length);
  });
});

describe("ArbitrumConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector(makeStubTokenClient());
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("publicHandle is the EVM address derived from privateKey", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    expect(inst.publicHandle).toBe(TEST_AGENT_ADDRESS);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("instrumentId follows naming convention", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    expect(inst.id).toBe("payment-instrument-arbitrum-alice");
  });

  it("rejects empty userId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.createInstrument({ userId: "" as UserId } as CreateInstrumentInput)
    ).rejects.toThrow(/userId/);
  });

  it("records chainId 421614 in providerMetadata", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    expect(inst.providerMetadata?.["chainId"]).toBe(421614);
    expect(inst.providerMetadata?.["tokenAddress"]).toBe(TEST_TOKEN);
  });
});

describe("ArbitrumConnector.getBalance", () => {
  it("returns balance from token client in atomic units", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.getBalance("payment-instrument-arbitrum-nope" as never)
    ).rejects.toThrow(/not found/);
  });
});

describe("ArbitrumConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const input: SignAuthorizationInput = {
      instrumentId: inst.id,
      request: buildPaymentRequest({ protocol: "bogus-v9" as ProtocolId }),
      session: buildSession(userAlice),
    };
    await expect(c.signAuthorization(input)).rejects.toThrow(/x402-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.signAuthorization({
        instrumentId: "bogus-id" as never,
        request: buildPaymentRequest(),
        session: buildSession(userAlice),
      })
    ).rejects.toThrow(/not found/);
  });

  it("produces a REAL EIP-712 signature (no stub) over the real token client path", async () => {
    // Use the real token-client signing path with a stubbed getName (the only
    // chain read in the signing flow), so signTypedData runs for real.
    const stub = makeStubTokenClient();
    // Delegate signTransferAuthorization to the real implementation bound to stub.
    const real = ArbitrumTokenClient.prototype.signTransferAuthorization;
    (stub as unknown as { signTransferAuthorization: unknown }).signTransferAuthorization =
      real.bind(stub);
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildPaymentRequest(),
      session: buildSession(userAlice),
    });
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.request.protocol).toBe(ARBITRUM_PROTOCOL);
  });

  it("echoes the request in the SignedAuthorization", async () => {
    const stub = makeStubTokenClient();
    const real = ArbitrumTokenClient.prototype.signTransferAuthorization;
    (stub as unknown as { signTransferAuthorization: unknown }).signTransferAuthorization =
      real.bind(stub);
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const req = buildPaymentRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userAlice),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    expect(signed.request.amount.amountAtomic).toBe(req.amount.amountAtomic);
    expect(signed.extra?.["chainId"]).toBe(421614);
  });
});

describe("ArbitrumConnector.settle", () => {
  it("returns success with txHash from mocked broadcast", async () => {
    const stub = makeStubTokenClient();
    const real = ArbitrumTokenClient.prototype.signTransferAuthorization;
    (stub as unknown as { signTransferAuthorization: unknown }).signTransferAuthorization =
      real.bind(stub);
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildPaymentRequest(),
      session: buildSession(userAlice),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
    expect(result.network).toBe(arbitrumSepoliaTestnet.name);
  });

  it("returns signature_invalid when extra.signed missing", async () => {
    const c = makeConnector(makeStubTokenClient());
    const result = await c.settle({
      request: buildPaymentRequest(),
      signer: TEST_AGENT_ADDRESS,
      signature: "0xabc",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});

describe("ArbitrumConnector keygen", () => {
  it("generates a fresh EVM keypair when no privateKey supplied", () => {
    const c = new ArbitrumConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Two no-key connectors must yield different addresses (truly random).
    const c2 = new ArbitrumConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c.agentAddress).not.toBe(c2.agentAddress);
  });
});
