/**
 * Tests for OptimismConnector.
 *
 * Real eth signing (viem PrivateKeyAccount) + stubbed network I/O via a
 * stub OptimismTokenClient. Validates:
 *   1. signAuthorization produces a real EIP-712 signature
 *   2. createInstrument is idempotent + rejects empty userId
 *   3. getBalance proxies to token client; throws on unknown id
 *   4. settle reads txHash from a mocked broadcast / fails gracefully
 *   5. ephemeral keypair generation when no privateKey supplied
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type UserId,
} from "@openagentpay/core";
import {
  OptimismConnector,
  OPTIMISM_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import { OptimismTokenClient } from "../src/token-client.js";

// A throwaway test private key (NEVER use this for real funds)
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // derived
const TEST_TOKEN = "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" as const;

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): OptimismTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 11155420, name: "OP Sepolia" },
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USDC"),
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
  return stub as unknown as OptimismTokenClient;
}

function makeConnector(tokenClient?: OptimismTokenClient): OptimismConnector {
  return new OptimismConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("OptimismConnector.getCapabilities", () => {
  it("reports optimism provider with x402-v1 + USDC", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(OPTIMISM_PROTOCOL);
  });

  it("is pure (returns equal results twice)", () => {
    const c = makeConnector(makeStubTokenClient());
    const a = c.getCapabilities();
    const b = c.getCapabilities();
    expect(a.walletProvider).toBe(b.walletProvider);
    expect(a.supportedAssets.length).toBe(b.supportedAssets.length);
  });
});

describe("OptimismConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector(makeStubTokenClient());
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
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
    expect(inst.id).toBe("payment-instrument-optimism-alice");
  });

  it("records chainId 11155420 + token address in metadata", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const meta = inst.providerMetadata as Record<string, unknown>;
    expect(meta["chainId"]).toBe(11155420);
    expect(meta["tokenAddress"]).toBe(TEST_TOKEN);
  });

  it("rejects empty userId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.createInstrument({ userId: "" as UserId } as CreateInstrumentInput)
    ).rejects.toThrow(/userId/);
  });
});

describe("OptimismConnector (ephemeral keypair)", () => {
  it("generates a valid EVM address when no privateKey supplied", async () => {
    const c = new OptimismConnector({
      tokenAddress: TEST_TOKEN,
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const inst = await c.createInstrument(createInput);
    expect(inst.publicHandle).toBe(c.agentAddress);
  });

  it("two ephemeral connectors get distinct addresses", () => {
    const a = new OptimismConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const b = new OptimismConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(a.agentAddress).not.toBe(b.agentAddress);
  });

  it("defaults to Circle USDC on OP Sepolia when no token supplied", () => {
    const c = new OptimismConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    // tokenClient is stubbed, so we assert via capabilities + no throw
    expect(c.getCapabilities().walletProvider).toBe(WALLET_PROVIDER_ID);
  });
});

describe("OptimismConnector.getBalance", () => {
  it("returns balance from token client in atomic units", async () => {
    const stub = makeStubTokenClient();
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.getBalance("payment-instrument-DOES-NOT-EXIST" as never)
    ).rejects.toThrow(/not found/);
  });
});

describe("OptimismConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const req = makeRequest({ protocol: "wrong-protocol" as ProtocolId });
    await expect(
      c.signAuthorization({ instrumentId: inst.id, request: req, session: makeSession() })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.signAuthorization({
        instrumentId: "bogus-id" as never,
        request: makeRequest({}),
        session: makeSession(),
      })
    ).rejects.toThrow(/not found/);
  });

  it("produces a REAL EIP-712 signature with default token client", async () => {
    // No stub → real signTypedData over a stubbed getName via publicClient mock.
    const tc = new OptimismTokenClient({
      tokenAddress: TEST_TOKEN,
      publicClient: {
        readContract: vi.fn(async () => "USDC"),
      } as never,
    });
    const c = makeConnector(tc);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    // a real secp256k1 signature is 65 bytes = 132 hex chars + 0x
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("returns SignedAuthorization with extra.signed populated (stub)", async () => {
    const stub = makeStubTokenClient();
    const fakeSigned = {
      authorization: {
        from: TEST_AGENT_ADDRESS as `0x${string}`,
        to: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23" as `0x${string}`,
        value: "1000000",
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      },
      signature: "0xsignaturehex" as `0x${string}`,
      v: 27,
      r: ("0x" + "00".repeat(32)) as `0x${string}`,
      s: ("0x" + "00".repeat(32)) as `0x${string}`,
      chainId: 11155420,
      verifyingContract: TEST_TOKEN as `0x${string}`,
    };
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSigned);

    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toBe("0xsignaturehex");
    expect((signed.extra as Record<string, unknown>)["signed"]).toBe(fakeSigned);
    expect((signed.extra as Record<string, unknown>)["chainId"]).toBe(11155420);
  });
});

describe("OptimismConnector.settle", () => {
  it("returns success + on-chain tx hash on successful broadcast", async () => {
    const stub = makeStubTokenClient();
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFakeSigned()
    );
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
    expect(result.network).toBe("OP Sepolia");
    const raw = result.raw as Record<string, string>;
    // viem's optimismSepolia builtin uses Blockscout as the default explorer.
    expect(raw.explorerUrl).toBe(
      "https://optimism-sepolia.blockscout.com/tx/0xfeedface"
    );
  });

  it("returns failure when extra.signed is missing", async () => {
    const c = makeConnector(makeStubTokenClient());
    const result = await c.settle({
      request: makeRequest({}),
      signer: "0x0",
      signature: "0x0",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("returns rpc_error on broadcast exception", async () => {
    const stub = makeStubTokenClient();
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFakeSigned()
    );
    (stub.broadcastSignedAuthorization as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("RPC unavailable")
    );
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("rpc_error");
    expect(result.errorMessage).toContain("RPC unavailable");
  });

  it("returns rpc_error when tx reverts", async () => {
    const stub = makeStubTokenClient();
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFakeSigned()
    );
    (stub.waitForReceipt as ReturnType<typeof vi.fn>).mockResolvedValue({
      blockNumber: 999n,
      gasUsed: 21_000n,
      status: "reverted" as const,
    });
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("rpc_error");
    expect(result.errorMessage).toContain("reverted");
  });
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeFakeSigned() {
  return {
    authorization: {
      from: TEST_AGENT_ADDRESS as `0x${string}`,
      to: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23" as `0x${string}`,
      value: "1000000",
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
    },
    signature: "0xsignaturehex" as `0x${string}`,
    v: 27,
    r: ("0x" + "00".repeat(32)) as `0x${string}`,
    s: ("0x" + "00".repeat(32)) as `0x${string}`,
    chainId: 11155420,
    verifyingContract: TEST_TOKEN as `0x${string}`,
  };
}

function makeRequest(opts: { protocol?: ProtocolId }): PaymentRequest {
  return {
    protocol: opts.protocol ?? OPTIMISM_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0x" + "ab".repeat(32),
    rawPayload: {},
  };
}

function makeSession() {
  const usd: Money = { amountAtomic: "1000000", decimals: 6, currency: "USDC" };
  return {
    id: "sess-1" as never,
    userId: userAlice,
    budget: usd,
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" } as Money,
    expiresAt: new Date(FIXED_NOW_MS + 3_600_000).toISOString(),
    createdAt: new Date(FIXED_NOW_MS).toISOString(),
    updatedAt: new Date(FIXED_NOW_MS).toISOString(),
    status: "active" as const,
  };
}
