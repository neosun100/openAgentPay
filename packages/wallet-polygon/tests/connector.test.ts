/**
 * Tests for PolygonAmoyConnector.
 *
 * Uses real eth signing (viem PrivateKeyAccount) but mocks network I/O via a
 * stub PolygonAmoyTokenClient. Validates:
 *   1. capabilities self-report
 *   2. createInstrument idempotency + empty-userId rejection
 *   3. getBalance proxies to token client
 *   4. signAuthorization produces a real EIP-712 signature
 *   5. settle reads txHash from a mocked broadcast / handles errors
 *   6. in-process keypair generation when no key supplied
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
  PolygonAmoyConnector,
  POLYGON_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import { PolygonAmoyTokenClient } from "../src/token-client.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // derived
const TEST_TOKEN = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" as const;

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): PolygonAmoyTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 80002, name: "Polygon Amoy" },
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
  return stub as unknown as PolygonAmoyTokenClient;
}

function makeConnector(tokenClient?: PolygonAmoyTokenClient): PolygonAmoyConnector {
  return new PolygonAmoyConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("PolygonAmoyConnector.getCapabilities", () => {
  it("reports polygon-amoy provider", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(POLYGON_PROTOCOL);
  });

  it("supported asset is bound to the Amoy USDC contract on chain 80002", () => {
    const c = makeConnector(makeStubTokenClient());
    const usdc = c.getCapabilities().supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.chain).toBe("eip155:80002");
    expect(usdc?.contract).toBe(TEST_TOKEN);
  });
});

describe("PolygonAmoyConnector.createInstrument", () => {
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
    expect(inst.id).toBe("payment-instrument-polygon-alice");
  });

  it("rejects empty userId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("providerMetadata carries chainId + token address", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    expect(inst.providerMetadata?.["chainId"]).toBe(80002);
    expect(inst.providerMetadata?.["tokenAddress"]).toBe(TEST_TOKEN);
  });
});

describe("PolygonAmoyConnector keypair generation", () => {
  it("generates a fresh EVM keypair when no privateKey supplied", async () => {
    const c1 = new PolygonAmoyConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const c2 = new PolygonAmoyConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c2.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress); // random ⇒ distinct
  });
});

describe("PolygonAmoyConnector.getBalance", () => {
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
      c.getBalance("payment-instrument-nope" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("PolygonAmoyConnector.signAuthorization", () => {
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
        instrumentId: "bogus" as never,
        request: makeRequest({}),
        session: makeSession(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });

  it("produces a REAL EIP-712 signature (no stubbed signer)", async () => {
    // Use a connector with the REAL token client behaviour for getName but mock
    // only the network reads — easiest is to stub getName and let the agent
    // account perform genuine signTypedData. We construct a stub whose
    // signTransferAuthorization delegates to the real implementation.
    const realish = new PolygonAmoyTokenClient({
      tokenAddress: TEST_TOKEN,
      publicClient: {
        readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
          functionName === "name" ? "USDC" : 6
        ),
      } as never,
    });
    const c = makeConnector(realish);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    // Real ECDSA signature: 0x + 65 bytes (130 hex chars).
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect((signed.extra as Record<string, unknown>)["chainId"]).toBe(80002);
  });

  it("returns SignedAuthorization echoing the request fields", async () => {
    const realish = new PolygonAmoyTokenClient({
      tokenAddress: TEST_TOKEN,
      publicClient: {
        readContract: vi.fn(async () => "USDC"),
      } as never,
    });
    const c = makeConnector(realish);
    const inst = await c.createInstrument(createInput);
    const req = makeRequest({});
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: makeSession(),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    expect(signed.request.amount.amountAtomic).toBe(req.amount.amountAtomic);
  });
});

describe("PolygonAmoyConnector.settle", () => {
  it("returns success + on-chain tx hash on successful broadcast", async () => {
    const stub = makeStubTokenClient();
    const fakeSigned = makeFakeSigned();
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(
      fakeSigned
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
    expect(result.network).toBe("Polygon Amoy");
    const raw = result.raw as Record<string, string>;
    expect(raw.explorerUrl).toContain("/tx/0xfeedface");
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
    chainId: 80002,
    verifyingContract: TEST_TOKEN as `0x${string}`,
  };
}

function makeRequest(opts: { protocol?: ProtocolId }): PaymentRequest {
  return {
    protocol: opts.protocol ?? POLYGON_PROTOCOL,
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
