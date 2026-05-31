/**
 * Tests for ModeSepoliaConnector.
 *
 * Real eth signing (viem PrivateKeyAccount) + stubbed network I/O via a partial
 * spy over a real ModeTokenClient. Validates the 5-method WalletConnector
 * contract, in-process keypair generation, and a REAL signature round-trip
 * with off-chain verification + tamper-detection.
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
  ModeSepoliaConnector,
  MODE_PROTOCOL,
  MODE_CAIP2,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  ModeTokenClient,
  type Eip3009SignedAuthorization,
} from "../src/token-client.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const FIXED_NOW_MS = 1778860654_000;

/** Real ModeTokenClient with only network methods stubbed (signing is REAL). */
function makeStubTokenClient(): ModeTokenClient {
  const real = new ModeTokenClient({ tokenAddress: TEST_TOKEN });
  vi.spyOn(real, "getDecimals").mockResolvedValue(6);
  vi.spyOn(real, "getName").mockResolvedValue("USDC");
  vi.spyOn(real, "getBalance").mockResolvedValue(1_000_000_000n); // 1000 USDC
  vi.spyOn(real, "isAuthorizationUsed").mockResolvedValue(false);
  vi.spyOn(real, "broadcastSignedAuthorization").mockResolvedValue("0xfeedface" as const);
  vi.spyOn(real, "waitForReceipt").mockResolvedValue({
    blockNumber: 12345n,
    gasUsed: 82_406n,
    status: "success" as const,
  });
  return real;
}

function makeConnector(tokenClient?: ModeTokenClient): ModeSepoliaConnector {
  return new ModeSepoliaConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("ModeSepoliaConnector.getCapabilities", () => {
  it("reports mode provider", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(MODE_PROTOCOL);
  });

  it("advertises the USDC asset bound to Mode Sepolia (eip155:919)", () => {
    const c = makeConnector(makeStubTokenClient());
    const usdc = c.getCapabilities().supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.decimals).toBeLessThanOrEqual(24); // asset-decimals invariant
    expect(usdc?.chain).toBe(MODE_CAIP2);
    expect(usdc?.contract).toBe(TEST_TOKEN);
  });

  it("exposes chainId 919", () => {
    const c = makeConnector(makeStubTokenClient());
    expect(c.chainId).toBe(919);
  });
});

describe("ModeSepoliaConnector.createInstrument", () => {
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
    expect(inst.id).toBe("payment-instrument-mode-alice");
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
    expect(inst.providerMetadata?.["chainId"]).toBe(919);
  });
});

describe("ModeSepoliaConnector keypair generation", () => {
  it("generates a fresh EVM keypair when no privateKey is supplied", () => {
    const c1 = new ModeSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const c2 = new ModeSepoliaConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c2.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress);
  });
});

describe("ModeSepoliaConnector.getBalance", () => {
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
      c.getBalance("payment-instrument-mode-nobody" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("ModeSepoliaConnector.signAuthorization", () => {
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
    ).rejects.toThrow(/Instrument not found/);
  });

  it("produces a REAL signature whose signer == agent address and verifies off-chain", async () => {
    const stub = makeStubTokenClient();
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    // 65-byte ECDSA signature → 132 hex chars (0x + 130)
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);

    // Off-chain verify the genuine EIP-712 signature recovers to the signer.
    const wire = (signed.extra as Record<string, unknown>)["signed"] as Eip3009SignedAuthorization;
    const ok = await stub.verifyTransferAuthorization(wire, "USDC");
    expect(ok).toBe(true);
  });

  it("tampered signature fails off-chain verification", async () => {
    const stub = makeStubTokenClient();
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const wire = (signed.extra as Record<string, unknown>)["signed"] as Eip3009SignedAuthorization;

    // Tamper #1: flip the amount → recovered signer no longer matches `from`.
    const tamperedValue: Eip3009SignedAuthorization = {
      ...wire,
      authorization: { ...wire.authorization, value: "999999999" },
    };
    expect(await stub.verifyTransferAuthorization(tamperedValue, "USDC")).toBe(false);

    // Tamper #2: corrupt the signature bytes.
    const flipped = wire.signature.slice(0, -2) + (wire.signature.endsWith("00") ? "11" : "00");
    const tamperedSig: Eip3009SignedAuthorization = {
      ...wire,
      signature: flipped as `0x${string}`,
    };
    expect(await stub.verifyTransferAuthorization(tamperedSig, "USDC")).toBe(false);
  });
});

describe("ModeSepoliaConnector.settle", () => {
  it("returns success + on-chain tx hash on successful broadcast", async () => {
    const stub = makeStubTokenClient();
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
    expect(result.network).toBe("Mode Sepolia");
    const raw = result.raw as Record<string, string>;
    expect(raw.explorerUrl).toContain("0xfeedface");
    expect(raw.explorerUrl).toContain("sepolia.explorer.mode.network");
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

describe("ModeSepoliaConnector.generateNonce", () => {
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
    protocol: opts.protocol ?? MODE_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
    asset: { symbol: "USDC", decimals: 6, chain: MODE_CAIP2, contract: TEST_TOKEN },
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
