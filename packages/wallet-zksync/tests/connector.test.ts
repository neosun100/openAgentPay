/**
 * Unit tests for ZkSyncConnector — offline, stubbed token-client, real EIP-712.
 * @license Apache-2.0
 */

import { describe, it, expect, vi } from "vitest";
import type { InstrumentId, PaymentRequest, UserId } from "@openagentpay/core";
import {
  ZkSyncConnector,
  ZKSYNC_PROTOCOL,
  WALLET_PROVIDER_ID,
  MemoryInstrumentStore,
} from "../src/connector.js";
import { ZkSyncTokenClient } from "../src/token-client.js";
import { zksyncSepolia, ZKSYNC_SEPOLIA_USDC } from "../src/chain.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

function makeStubTokenClient(over: Record<string, unknown> = {}): ZkSyncTokenClient {
  const stub = {
    tokenAddress: ZKSYNC_SEPOLIA_USDC as never,
    chain: zksyncSepolia,
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USD Coin"),
    getBalance: vi.fn(async () => 5_000_000n),
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
      signature: "0xc0ffee" as never,
      v: 28,
      r: ("0x" + "11".repeat(32)) as never,
      s: ("0x" + "22".repeat(32)) as never,
      chainId: 300,
      verifyingContract: ZKSYNC_SEPOLIA_USDC as never,
    })),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 999n,
      gasUsed: 80_000n,
      status: "success" as const,
    })),
    ...over,
  };
  return stub as unknown as ZkSyncTokenClient;
}

function makeConnector(over: Record<string, unknown> = {}) {
  return new ZkSyncConnector({
    privateKey: TEST_PRIVATE_KEY,
    instrumentStore: new MemoryInstrumentStore(),
    tokenClient: makeStubTokenClient(),
    ...over,
  });
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: ZKSYNC_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: "0x000000000000000000000000000000000000dEaD",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "0x" + "1".repeat(64),
    rawPayload: {},
    ...overrides,
  };
}

describe("ZkSyncConnector — capabilities", () => {
  it("reports the zksync-era provider id and x402-v1 protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toEqual([ZKSYNC_PROTOCOL]);
    expect(caps.settlesOnChain).toBe(true);
  });

  it("advertises USDC (6 decimals) on eip155:300", () => {
    const caps = makeConnector().getCapabilities();
    const usdc = caps.supportedAssets[0];
    expect(usdc?.symbol).toBe("USDC");
    expect(usdc?.decimals).toBe(6);
  });
});

describe("ZkSyncConnector — createInstrument", () => {
  it("rejects empty userId", async () => {
    const c = makeConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(
      /userId is required/
    );
  });

  it("binds the instrument publicHandle to the agent address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    expect(inst.publicHandle).toBe(TEST_AGENT_ADDRESS);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.providerMetadata?.["chainId"]).toBe(300);
  });

  it("is idempotent — same userId returns the same instrument", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "bob" as UserId });
    const b = await c.createInstrument({ userId: "bob" as UserId });
    expect(a.id).toBe(b.id);
  });
});

describe("ZkSyncConnector — getBalance", () => {
  it("throws on unknown instrument id", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-zksync-ghost" as InstrumentId)
    ).rejects.toThrow(/Instrument not found/);
  });

  it("returns balance as atomic USDC money", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "carol" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("5000000");
    expect(bal.money.currency).toBe("USDC");
    expect(bal.money.decimals).toBe(6);
  });
});

describe("ZkSyncConnector — signAuthorization", () => {
  it("rejects a non-x402 protocol", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "dave" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "stripe-v1" as PaymentRequest["protocol"] }),
      })
    ).rejects.toThrow(/only supports protocol x402-v1/);
  });

  it("throws on unknown instrument id", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-zksync-ghost" as InstrumentId,
        request: buildRequest(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });

  it("produces a SignedAuthorization carrying the wire payload + chainId", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "erin" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toMatch(/^0x/);
    expect(signed.extra?.["chainId"]).toBe(300);
    expect(signed.extra?.["signed"]).toBeDefined();
  });

  it("signs a REAL EIP-712 signature when using the live token-client name fetch stub", async () => {
    // Use a real token-client but stub only getName (signing path is real viem)
    const realClient = new ZkSyncTokenClient({ tokenAddress: ZKSYNC_SEPOLIA_USDC });
    vi.spyOn(realClient, "getName").mockResolvedValue("USD Coin");
    const c = makeConnector({ tokenClient: realClient });
    const inst = await c.createInstrument({ userId: "frank" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    // A real EIP-712 ECDSA signature is 65 bytes → 132 hex chars incl 0x.
    expect(signed.signature.length).toBe(132);
  });
});

describe("ZkSyncConnector — settle", () => {
  it("returns success with tx hash + explorer url from a signed authorization", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "grace" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
    expect((result.raw as Record<string, unknown>)?.["explorerUrl"]).toMatch(
      /sepolia\.explorer\.zksync\.io\/tx\/0xfeedface/
    );
  });

  it("fails gracefully when signed.extra.signed is missing", async () => {
    const c = makeConnector();
    const result = await c.settle({
      request: buildRequest(),
      signer: TEST_AGENT_ADDRESS,
      signature: "0xdead",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("reports rpc_error when broadcast throws", async () => {
    const failing = makeStubTokenClient({
      broadcastSignedAuthorization: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    const c = makeConnector({ tokenClient: failing });
    const inst = await c.createInstrument({ userId: "heidi" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    const result = await c.settle(signed);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("rpc_error");
    expect(result.errorMessage).toMatch(/rpc down/);
  });
});

describe("ZkSyncConnector — keypair generation", () => {
  it("auto-generates a fresh EOA when no private key is supplied", () => {
    const c1 = new ZkSyncConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const c2 = new ZkSyncConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress); // random per instance
  });

  it("generates a 32-byte hex nonce", () => {
    const nonce = makeConnector().generateNonce();
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("ZkSyncConnector — chain wiring", () => {
  it("targets zkSync Era Sepolia (chainId 300)", () => {
    expect(zksyncSepolia.id).toBe(300);
  });
});
