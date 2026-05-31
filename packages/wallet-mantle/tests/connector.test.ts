/**
 * Tests for MantleSepoliaConnector + MantleTokenClient.
 *
 * Real eth signing (viem PrivateKeyAccount) + stubbed network I/O via a stub
 * MantleTokenClient. Validates the 5-method WalletConnector contract, the
 * in-process keypair-generation feature, and — crucially — a REAL verifiable
 * secp256k1 EIP-712 signature with a tampered-fails negative test.
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
  MantleSepoliaConnector,
  MANTLE_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import { MantleTokenClient } from "../src/token-client.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): MantleTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 5003, name: "Mantle Sepolia Testnet" },
    publicClient: {} as never,
    domainName: "USD Coin",
    buildTypedData: vi.fn(),
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USD Coin"),
    getBalance: vi.fn(async () => 1_000_000_000n), // 1000 USDC
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization: vi.fn(),
    verifySignedAuthorization: vi.fn(async () => true),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as MantleTokenClient;
}

function makeConnector(tokenClient?: MantleTokenClient): MantleSepoliaConnector {
  return new MantleSepoliaConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("MantleSepoliaConnector.getCapabilities", () => {
  it("reports mantle provider", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(MANTLE_PROTOCOL);
  });

  it("advertises the USDC asset bound to Mantle Sepolia (eip155:5003)", () => {
    const c = makeConnector(makeStubTokenClient());
    const usdc = c.getCapabilities().supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.chain).toBe("eip155:5003");
    expect(usdc?.contract).toBe(TEST_TOKEN);
  });

  it("exposes chainId 5003", () => {
    const c = makeConnector(makeStubTokenClient());
    expect(c.chainId).toBe(5003);
  });

  it("getCapabilities is pure (equal results twice)", () => {
    const c = makeConnector(makeStubTokenClient());
    expect(c.getCapabilities()).toEqual(c.getCapabilities());
  });
});

describe("MantleSepoliaConnector.createInstrument", () => {
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
    expect(inst.id).toBe("payment-instrument-mantle-alice");
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
    expect(inst.providerMetadata?.["chainId"]).toBe(5003);
  });
});

describe("MantleSepoliaConnector keypair generation", () => {
  it("generates a fresh EVM keypair when no privateKey is supplied", async () => {
    const c1 = new MantleSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const c2 = new MantleSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c2.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress);
  });
});

describe("MantleSepoliaConnector.getBalance", () => {
  it("returns balance from token client in atomic units", async () => {
    const stub = makeStubTokenClient();
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
    expect(bal.asset.chain).toBe("eip155:5003");
  });

  it("falls back to zero balance when RPC read fails (placeholder USDC)", async () => {
    const stub = makeStubTokenClient();
    (stub.getDecimals as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("execution reverted: no code at address")
    );
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.decimals).toBe(6);
    expect(() => BigInt(bal.money.amountAtomic)).not.toThrow();
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.getBalance("payment-instrument-mantle-nobody" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("MantleSepoliaConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const req = makeRequest({ protocol: "wrong-protocol" as ProtocolId });
    await expect(
      c.signAuthorization({ instrumentId: inst.id, request: req, session })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-mantle-ghost" as never,
        request: makeRequest({}),
        session: makeSession(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("MantleSepoliaConnector REAL signature (no stub)", () => {
  it("produces a verifiable EIP-712 signature recoverable to the signer", async () => {
    // Real token client (no RPC needed for sign — domain name is config).
    const tokenClient = new MantleTokenClient({ tokenAddress: TEST_TOKEN });
    const c = makeConnector(tokenClient);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    // signer echoes the agent address
    expect(signed.signer.toLowerCase()).toBe(TEST_AGENT_ADDRESS.toLowerCase());
    // 65-byte secp256k1 signature (0x + 130 hex chars)
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const wire = signed.extra?.["signed"] as Parameters<
      MantleTokenClient["verifySignedAuthorization"]
    >[0];
    const ok = await tokenClient.verifySignedAuthorization(wire);
    expect(ok).toBe(true);
  });

  it("tampered authorization fails verification", async () => {
    const tokenClient = new MantleTokenClient({ tokenAddress: TEST_TOKEN });
    const c = makeConnector(tokenClient);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const wire = signed.extra?.["signed"] as Awaited<
      ReturnType<MantleTokenClient["signTransferAuthorization"]>
    >;
    // Tamper with the value — signature should no longer recover to `from`.
    const tampered = {
      ...wire,
      authorization: { ...wire.authorization, value: "999999999" },
    };
    const ok = await tokenClient.verifySignedAuthorization(tampered);
    expect(ok).toBe(false);
  });

  it("verifyingContract + chainId are bound into extra", async () => {
    const tokenClient = new MantleTokenClient({ tokenAddress: TEST_TOKEN });
    const c = makeConnector(tokenClient);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    expect(signed.extra?.["chainId"]).toBe(5003);
    expect(signed.extra?.["verifyingContract"]).toBe(TEST_TOKEN);
  });

  it("rejects when signer != authorization.from", async () => {
    const tokenClient = new MantleTokenClient({ tokenAddress: TEST_TOKEN });
    const account = (await import("viem/accounts")).privateKeyToAccount(
      "0x0000000000000000000000000000000000000000000000000000000000000002"
    );
    await expect(
      tokenClient.signTransferAuthorization(account, {
        from: TEST_AGENT_ADDRESS as `0x${string}`, // mismatched
        to: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23" as `0x${string}`,
        value: "1000",
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      })
    ).rejects.toThrow(/does not match authorization.from/);
  });
});

describe("MantleSepoliaConnector.settle", () => {
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
      chainId: 5003,
      verifyingContract: TEST_TOKEN as `0x${string}`,
      domainName: "USD Coin",
      domainVersion: "2",
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
    expect(result.network).toBe("Mantle Sepolia Testnet");
    const raw = result.raw as Record<string, string>;
    expect(raw.explorerUrl).toContain("0xfeedface");
    expect(raw.explorerUrl).toContain("sepolia.mantlescan.xyz");
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
      chainId: 5003,
      verifyingContract: TEST_TOKEN as `0x${string}`,
      domainName: "USD Coin",
      domainVersion: "2",
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

describe("MantleSepoliaConnector.generateNonce", () => {
  it("produces a 32-byte 0x-prefixed hex nonce", () => {
    const c = makeConnector(makeStubTokenClient());
    const nonce = c.generateNonce();
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces unique nonces", () => {
    const c = makeConnector(makeStubTokenClient());
    expect(c.generateNonce()).not.toBe(c.generateNonce());
  });
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeRequest(opts: { protocol?: ProtocolId }): PaymentRequest {
  return {
    protocol: opts.protocol ?? MANTLE_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
    asset: { symbol: "USDC", decimals: 6, chain: "eip155:5003", contract: TEST_TOKEN },
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
