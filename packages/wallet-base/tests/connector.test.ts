/**
 * Tests for BaseSepoliaConnector.
 *
 * Real eth signing (viem PrivateKeyAccount) + stubbed network I/O via a stub
 * BaseTokenClient. Validates the 5-method WalletConnector contract plus the
 * in-process keypair-generation feature.
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
  BaseSepoliaConnector,
  BASE_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import { BaseTokenClient } from "../src/token-client.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): BaseTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 84532, name: "Base Sepolia" },
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
  return stub as unknown as BaseTokenClient;
}

function makeConnector(tokenClient?: BaseTokenClient): BaseSepoliaConnector {
  return new BaseSepoliaConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("BaseSepoliaConnector.getCapabilities", () => {
  it("reports base-sepolia provider", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(BASE_PROTOCOL);
  });

  it("advertises the USDC asset bound to Base Sepolia (eip155:84532)", () => {
    const c = makeConnector(makeStubTokenClient());
    const usdc = c.getCapabilities().supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.chain).toBe("eip155:84532");
    expect(usdc?.contract).toBe(TEST_TOKEN);
  });

  it("exposes chainId 84532", () => {
    const c = makeConnector(makeStubTokenClient());
    expect(c.chainId).toBe(84532);
  });
});

describe("BaseSepoliaConnector.createInstrument", () => {
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
    expect(inst.id).toBe("payment-instrument-base-alice");
  });

  it("rejects empty userId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("records chainId in providerMetadata", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    expect(inst.providerMetadata?.["chainId"]).toBe(84532);
  });
});

describe("BaseSepoliaConnector keypair generation", () => {
  it("generates a fresh EVM keypair when no privateKey is supplied", async () => {
    const c1 = new BaseSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const c2 = new BaseSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    // Each connector gets its own random EOA address.
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c2.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress);
  });
});

describe("BaseSepoliaConnector.getBalance", () => {
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
      c.getBalance("payment-instrument-base-nobody" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("BaseSepoliaConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const req = makeRequest({ protocol: "wrong-protocol" as ProtocolId });
    await expect(
      c.signAuthorization({ instrumentId: inst.id, request: req, session })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("returns SignedAuthorization with extra.signed populated", async () => {
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
      chainId: 84532,
      verifyingContract: TEST_TOKEN as `0x${string}`,
    };
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSigned);

    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session,
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toBe("0xsignaturehex");
    expect((signed.extra as Record<string, unknown>)["signed"]).toBe(fakeSigned);
    expect((signed.extra as Record<string, unknown>)["chainId"]).toBe(84532);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.signAuthorization({
        instrumentId: "bogus-id" as never,
        request: makeRequest({}),
        session: makeSession(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("BaseSepoliaConnector.settle", () => {
  it("returns success + on-chain tx hash on successful broadcast", async () => {
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
      chainId: 84532,
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
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
    expect(result.network).toBe("Base Sepolia");
    const raw = result.raw as Record<string, string>;
    expect(raw.explorerUrl).toContain("0xfeedface");
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
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorization: {
        from: TEST_AGENT_ADDRESS as `0x${string}`,
        to: "0x0" as `0x${string}`,
        value: "1000",
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      },
      signature: "0x0" as `0x${string}`,
      v: 27,
      r: ("0x" + "00".repeat(32)) as `0x${string}`,
      s: ("0x" + "00".repeat(32)) as `0x${string}`,
      chainId: 84532,
      verifyingContract: TEST_TOKEN as `0x${string}`,
    });
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
});

describe("BaseSepoliaConnector.generateNonce", () => {
  it("produces a 32-byte 0x-prefixed hex nonce", () => {
    const c = makeConnector(makeStubTokenClient());
    const nonce = c.generateNonce();
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeRequest(opts: { protocol?: ProtocolId }): PaymentRequest {
  return {
    protocol: opts.protocol ?? BASE_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
    asset: { symbol: "USDC", decimals: 6, chain: "eip155:84532", contract: TEST_TOKEN },
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
