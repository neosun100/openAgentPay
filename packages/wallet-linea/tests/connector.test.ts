/**
 * Tests for LineaConnector.
 *
 * Uses real eth signing (viem PrivateKeyAccount) via the default offline-safe
 * token client. Validates the WalletConnector contract end-to-end without RPC.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type UserId,
} from "@openagentpay/core";
import {
  LineaConnector,
  DefaultLineaTokenClient,
  LINEA_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  type LineaTokenClient,
} from "../src/connector.js";
import { LINEA_SEPOLIA_USDC, lineaSepoliaTestnet } from "../src/chain.js";

// A throwaway test private key (NEVER use this for real funds)
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // derived from above

const FIXED_NOW_MS = 1778860654_000;

function makeConnector(tokenClient?: LineaTokenClient): LineaConnector {
  return new LineaConnector({
    privateKey: TEST_PRIVATE_KEY,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("LineaConnector.getCapabilities", () => {
  it("reports linea provider and x402-v1 protocol", () => {
    const c = makeConnector();
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(LINEA_PROTOCOL);
  });

  it("getCapabilities is pure (stable across calls)", () => {
    const c = makeConnector();
    expect(c.getCapabilities()).toEqual(c.getCapabilities());
  });
});

describe("LineaConnector.createInstrument", () => {
  it("rejects empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector();
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
  });

  it("publicHandle is the EVM address derived from privateKey", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    expect(inst.publicHandle).toBe(TEST_AGENT_ADDRESS);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("instrumentId follows naming convention", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    expect(inst.id).toBe("payment-instrument-linea-alice");
  });

  it("providerMetadata carries chainId 59141 + token address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    expect(inst.providerMetadata?.["chainId"]).toBe(59141);
    expect(inst.providerMetadata?.["tokenAddress"]).toBe(LINEA_SEPOLIA_USDC);
  });
});

describe("LineaConnector key generation", () => {
  it("generates a fresh EVM keypair when no privateKey supplied", () => {
    const c1 = new LineaConnector({ instrumentStore: new MemoryInstrumentStore() });
    const c2 = new LineaConnector({ instrumentStore: new MemoryInstrumentStore() });
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress);
  });

  it("generateNonce returns 32-byte hex", () => {
    const c = makeConnector();
    const nonce = c.generateNonce();
    expect(nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});

describe("LineaConnector.getBalance", () => {
  it("returns balance from token client in atomic units", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
  });

  it("throws on unknown instrument id", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-linea-nobody" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("LineaConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const req = makeRequest({ protocol: "wrong-protocol" as ProtocolId });
    await expect(
      c.signAuthorization({ instrumentId: inst.id, request: req, session })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrument id", async () => {
    const c = makeConnector();
    const session = makeSession();
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-linea-nobody" as never,
        request: makeRequest({}),
        session,
      })
    ).rejects.toThrow(/Instrument not found/);
  });

  it("produces a real EIP-712 signature (65-byte hex) + populated extra", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session,
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    // 0x + 130 hex chars = 65-byte ECDSA signature
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    const extra = signed.extra as Record<string, unknown>;
    expect(extra["chainId"]).toBe(59141);
    expect(extra["verifyingContract"]).toBe(LINEA_SEPOLIA_USDC);
    expect(extra["signed"]).toBeDefined();
  });
});

describe("LineaConnector.settle", () => {
  it("returns success + mock tx hash on successful broadcast", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.network).toBe("Linea Sepolia Testnet");
    const raw = result.raw as Record<string, string>;
    expect(raw["explorerUrl"]).toContain("https://sepolia.lineascan.build/tx/");
  });

  it("returns signature_invalid when extra.signed is missing", async () => {
    const c = makeConnector();
    const result = await c.settle({
      request: makeRequest({}),
      signer: "0x0",
      signature: "0x0",
      // no extra.signed
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("returns rpc_error on broadcast exception", async () => {
    const failingClient = new DefaultLineaTokenClient({
      tokenAddress: LINEA_SEPOLIA_USDC as never,
      chain: lineaSepoliaTestnet,
    });
    // Override broadcast to throw.
    failingClient.broadcastSignedAuthorization = async () => {
      throw new Error("RPC unavailable");
    };
    const c = makeConnector(failingClient);
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

function makeRequest(opts: { protocol?: ProtocolId }): PaymentRequest {
  return {
    protocol: opts.protocol ?? LINEA_PROTOCOL,
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
