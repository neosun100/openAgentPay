/**
 * Tests for BerachainMainnetConnector.
 *
 * Real eth signing (viem PrivateKeyAccount) + stubbed network I/O via a stub
 * BeraTokenClient. Validates the 5-method WalletConnector contract, in-process
 * keypair generation, and — crucially — a REAL verifiable EIP-712 signature
 * with a tampered-payload-fails check.
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import {
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type UserId,
} from "@openagentpay/core";
import {
  BerachainMainnetConnector,
  BERA_PROTOCOL,
  BERA_CAIP2,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import { BeraTokenClient, EIP712_TYPES } from "../src/token-client.js";
import { BERACHAIN_MAINNET_CHAIN_ID } from "../src/chain.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
// Address derived from private key 0x..01 (well-known viem test vector).
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x549943e04f40284185054145c6E4e9568C1D3241" as const;
const TOKEN_NAME = "USD Coin";

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): BeraTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: BERACHAIN_MAINNET_CHAIN_ID, name: "Berachain" },
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => TOKEN_NAME),
    getBalance: vi.fn(async () => 1_000_000_000n), // 1000 USDC
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization: vi.fn(
      async (
        _signer: unknown,
        authorization: { from: string; to: string; value: string; validAfter: number; validBefore: number; nonce: string },
      ) => ({
        authorization,
        signature: "0x" + "11".repeat(65),
        v: 27,
        r: "0x" + "00".repeat(32),
        s: "0x" + "00".repeat(32),
        chainId: BERACHAIN_MAINNET_CHAIN_ID,
        verifyingContract: TEST_TOKEN,
      }),
    ),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as BeraTokenClient;
}

function makeConnector(): BerachainMainnetConnector {
  // Use the REAL token client for signing (offline — tokenName provided),
  // but it won't hit the network because signAuthorization passes tokenName.
  return new BerachainMainnetConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    tokenName: TOKEN_NAME,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
  });
}

function makeConnectorWithStub(tokenClient: BeraTokenClient): BerachainMainnetConnector {
  return new BerachainMainnetConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    tokenName: TOKEN_NAME,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    tokenClient,
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

// ---------------------------------------------------------------------------
//  getCapabilities
// ---------------------------------------------------------------------------

describe("BerachainMainnetConnector.getCapabilities", () => {
  it("reports berachain-mainnet provider", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedProtocols).toContain(BERA_PROTOCOL);
  });

  it("advertises the USDC asset bound to Berachain mainnet (eip155:80094)", () => {
    const usdc = makeConnector()
      .getCapabilities()
      .supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.chain).toBe(BERA_CAIP2);
    expect(usdc?.contract).toBe(TEST_TOKEN);
  });

  it("exposes chainId 80094", () => {
    expect(makeConnector().chainId).toBe(80094);
  });

  it("asset decimals <= 24", () => {
    for (const a of makeConnector().getCapabilities().supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("BerachainMainnetConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector();
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
  });

  it("publicHandle is the EVM address derived from privateKey", async () => {
    const inst = await makeConnector().createInstrument(createInput);
    expect(inst.publicHandle).toBe(TEST_AGENT_ADDRESS);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("instrumentId follows naming convention", async () => {
    const inst = await makeConnector().createInstrument(createInput);
    expect(inst.id).toBe("payment-instrument-bera-alice");
  });

  it("rejects empty userId", async () => {
    await expect(
      makeConnector().createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("records chainId in providerMetadata", async () => {
    const inst = await makeConnector().createInstrument(createInput);
    expect(inst.providerMetadata?.["chainId"]).toBe(80094);
  });
});

// ---------------------------------------------------------------------------
//  keypair generation
// ---------------------------------------------------------------------------

describe("BerachainMainnetConnector keypair generation", () => {
  it("generates a fresh EVM keypair when no privateKey is supplied", () => {
    const c1 = new BerachainMainnetConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    const c2 = new BerachainMainnetConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c1.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c2.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c1.agentAddress).not.toBe(c2.agentAddress);
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("BerachainMainnetConnector.getBalance", () => {
  it("returns balance from token client in atomic units", async () => {
    const c = makeConnectorWithStub(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
  });

  it("throws on unknown instrumentId", async () => {
    await expect(
      makeConnectorWithStub(makeStubTokenClient()).getBalance(
        "payment-instrument-bera-nobody" as never
      )
    ).rejects.toThrow(/Instrument not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization — REAL verifiable signature
// ---------------------------------------------------------------------------

describe("BerachainMainnetConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: makeRequest({ protocol: "wrong-protocol" as ProtocolId }),
        session: makeSession(),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrumentId", async () => {
    await expect(
      makeConnector().signAuthorization({
        instrumentId: "bogus-id" as never,
        request: makeRequest({}),
        session: makeSession(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });

  it("produces a REAL EIP-712 signature that recovers to the agent address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const req = makeRequest({});
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: makeSession(),
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toMatch(/^0x[0-9a-f]+$/);

    // Independently recover the signer from the typed data + signature.
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: TOKEN_NAME,
        version: "2",
        chainId: BigInt(BERACHAIN_MAINNET_CHAIN_ID),
        verifyingContract: TEST_TOKEN as Address,
      },
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: TEST_AGENT_ADDRESS as Address,
        to: req.recipient as Address,
        value: BigInt(req.amount.amountAtomic),
        validAfter: BigInt(req.validAfter),
        validBefore: BigInt(req.validBefore),
        nonce: req.nonce as Hex,
      },
      signature: signed.signature as Hex,
    });
    expect(recovered.toLowerCase()).toBe(TEST_AGENT_ADDRESS.toLowerCase());
  });

  it("TAMPERED payload fails verification (signature is bound to message)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const req = makeRequest({});
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: makeSession(),
    });

    // Recover against a TAMPERED message (value bumped by 1 atomic unit).
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: TOKEN_NAME,
        version: "2",
        chainId: BigInt(BERACHAIN_MAINNET_CHAIN_ID),
        verifyingContract: TEST_TOKEN as Address,
      },
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: TEST_AGENT_ADDRESS as Address,
        to: req.recipient as Address,
        value: BigInt(req.amount.amountAtomic) + 1n, // tamper!
        validAfter: BigInt(req.validAfter),
        validBefore: BigInt(req.validBefore),
        nonce: req.nonce as Hex,
      },
      signature: signed.signature as Hex,
    });
    // The recovered address must NOT be the real signer.
    expect(recovered.toLowerCase()).not.toBe(TEST_AGENT_ADDRESS.toLowerCase());
  });

  it("carries the wire-signed payload + chainId in extra", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const extra = signed.extra as Record<string, unknown>;
    expect(extra["chainId"]).toBe(80094);
    expect(extra["verifyingContract"]).toBe(TEST_TOKEN);
    expect(extra["signed"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("BerachainMainnetConnector.settle", () => {
  it("returns success + on-chain tx hash on successful broadcast", async () => {
    const stub = makeStubTokenClient();
    const c = makeConnectorWithStub(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
    expect(result.network).toBe("Berachain");
    const raw = result.raw as Record<string, string>;
    expect(raw.explorerUrl).toContain("0xfeedface");
    expect(raw.explorerUrl).toContain("berascan.com");
  });

  it("returns failure when extra.signed is missing", async () => {
    const result = await makeConnectorWithStub(makeStubTokenClient()).settle({
      request: makeRequest({}),
      signer: "0x0",
      signature: "0x0",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("returns rpc_error on broadcast exception (offline-safe)", async () => {
    const stub = makeStubTokenClient();
    (stub.broadcastSignedAuthorization as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("RPC unavailable")
    );
    const c = makeConnectorWithStub(stub);
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
//  generateNonce
// ---------------------------------------------------------------------------

describe("BerachainMainnetConnector.generateNonce", () => {
  it("produces a 32-byte 0x-prefixed hex nonce", () => {
    expect(makeConnector().generateNonce()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeRequest(opts: { protocol?: ProtocolId }): PaymentRequest {
  return {
    protocol: opts.protocol ?? BERA_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
    asset: { symbol: "USDC", decimals: 6, chain: BERA_CAIP2, contract: TEST_TOKEN },
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
