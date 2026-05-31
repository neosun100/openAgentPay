/**
 * Tests for ScrollSepoliaConnector.
 *
 * Real EIP-712 signing (in-process viem PrivateKeyAccount) + offline domain
 * name override, so signing/verification run with zero network I/O. Validates
 * the 5-method WalletConnector contract, the in-process keypair-generation
 * feature, a REAL verifiable signature (verify() == true), and that a tampered
 * authorization fails verification.
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type Session,
  type UserId,
} from "@openagentpay/core";
import {
  ScrollSepoliaConnector,
  SCROLL_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  ScrollTokenClient,
  type Eip3009SignedAuthorization,
} from "../src/token-client.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
// Address derived from private key #1 (well-known).
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x6C8c3F5e9f8c2D2b3e7a4D5C6b7A8F9E0a1b2C3D" as const;

const FIXED_NOW_MS = 1778860654_000;

/** Stub token client — stubs network reads, keeps real EIP-712 sign/verify. */
function makeStubTokenClient(): ScrollTokenClient {
  const real = new ScrollTokenClient({
    tokenAddress: TEST_TOKEN,
    domainName: "USD Coin",
    domainVersion: "2",
    publicClient: {} as never,
  });
  // Stub only the network reads / broadcast; keep real sign + verify.
  real.getDecimals = vi.fn(async () => 6);
  real.getBalance = vi.fn(async () => 1_000_000_000n); // 1000 USDC
  real.getDomainSeparator = vi.fn(async () => ("0x" + "00".repeat(32)) as `0x${string}`);
  real.isAuthorizationUsed = vi.fn(async () => false);
  real.broadcastSignedAuthorization = vi.fn(async () => "0xfeedface" as `0x${string}`);
  real.waitForReceipt = vi.fn(async () => ({
    blockNumber: 12345n,
    gasUsed: 82_406n,
    status: "success" as const,
  }));
  return real;
}

function makeConnector(tokenClient?: ScrollTokenClient): ScrollSepoliaConnector {
  return new ScrollSepoliaConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("ScrollSepoliaConnector.getCapabilities", () => {
  it("reports scroll provider", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(SCROLL_PROTOCOL);
    expect(caps.features?.["zkEvm"]).toBe(true);
  });

  it("advertises the USDC asset bound to Scroll Sepolia (eip155:534351)", () => {
    const c = makeConnector(makeStubTokenClient());
    const usdc = c.getCapabilities().supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.chain).toBe("eip155:534351");
    expect(usdc?.contract).toBe(TEST_TOKEN);
  });

  it("exposes chainId 534351", () => {
    const c = makeConnector(makeStubTokenClient());
    expect(c.chainId).toBe(534351);
  });

  it("getCapabilities is pure (equal across calls)", () => {
    const c = makeConnector(makeStubTokenClient());
    const a = c.getCapabilities();
    const b = c.getCapabilities();
    expect(a.walletProvider).toBe(b.walletProvider);
    expect(a.supportedProtocols.length).toBe(b.supportedProtocols.length);
  });
});

describe("ScrollSepoliaConnector.createInstrument", () => {
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
    expect(inst.id).toBe("payment-instrument-scroll-alice");
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
    expect(inst.providerMetadata?.["chainId"]).toBe(534351);
  });
});

describe("ScrollSepoliaConnector keypair generation", () => {
  it("generates a fresh EVM keypair when no privateKey is supplied", () => {
    const c1 = new ScrollSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const c2 = new ScrollSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c2.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress);
  });
});

describe("ScrollSepoliaConnector.getBalance", () => {
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
      c.getBalance("payment-instrument-scroll-nobody" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("ScrollSepoliaConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const req = makeRequest({ protocol: "wrong-protocol" as ProtocolId });
    await expect(
      c.signAuthorization({ instrumentId: inst.id, request: req, session: makeSession() })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("produces a REAL verifiable EIP-712 signature (verify() == true)", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    // 65-byte secp256k1 signature, 0x + 130 hex chars.
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    const ok = await c.verify(signed);
    expect(ok).toBe(true);
  });

  it("verify() FAILS on a tampered authorization (recipient swapped)", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    // Tamper: mutate the signed authorization's recipient after signing.
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const tampered: Eip3009SignedAuthorization = {
      ...wire,
      authorization: {
        ...wire.authorization,
        to: "0x000000000000000000000000000000000000dEaD" as `0x${string}`,
      },
    };
    const tamperedSigned = {
      ...signed,
      extra: { ...signed.extra, signed: tampered },
    };
    const ok = await c.verify(tamperedSigned);
    expect(ok).toBe(false);
  });

  it("populates extra.signed + chainId", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const extra = signed.extra as Record<string, unknown>;
    expect(extra["signed"]).toBeDefined();
    expect(extra["chainId"]).toBe(534351);
    expect(extra["verifyingContract"]).toBe(TEST_TOKEN);
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

describe("ScrollSepoliaConnector.settle", () => {
  it("returns success + on-chain tx hash on successful broadcast", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
    expect(typeof result.network).toBe("string");
    expect(result.network.length).toBeGreaterThan(0);
    const raw = result.raw as Record<string, string>;
    expect(raw["explorerUrl"]).toContain("0xfeedface");
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

describe("ScrollSepoliaConnector.generateNonce", () => {
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
    protocol: opts.protocol ?? SCROLL_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaAa86bb77B5a14B23E5724fb12E4685809599F23",
    asset: { symbol: "USDC", decimals: 6, chain: "eip155:534351", contract: TEST_TOKEN },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0x" + "ab".repeat(32),
    rawPayload: {},
  };
}

function makeSession(): Session {
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
