/**
 * Tests for SonicConnector.
 *
 * Real EVM signing (viem PrivateKeyAccount) + stubbed network I/O via a stub
 * SonicTokenClient. Validates the 5-method WalletConnector contract plus the
 * in-process keypair-generation feature, offline-safe mock settle, and a REAL
 * verifiable EIP-712 signature with verify() + tampered-fails assertions.
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
  type UserId,
} from "@openagentpay/core";
import {
  recoverTypedDataAddress,
  verifyTypedData,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SonicConnector,
  SONIC_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  SONIC_BLAZE_CHAIN_ID,
} from "../src/connector.js";
import {
  SonicTokenClient,
  EIP712_TYPES,
  type Eip3009SignedAuthorization,
} from "../src/token-client.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
// Address derived from private key 0x..01 (well-known viem test vector).
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" as const;
const DOMAIN_NAME = "USD Coin";

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): SonicTokenClient {
  // Real signing delegates to a real SonicTokenClient (offline, domainName set);
  // only the network reads (decimals/balance/broadcast/receipt) are stubbed.
  const real = new SonicTokenClient({
    tokenAddress: TEST_TOKEN,
    domainName: DOMAIN_NAME,
  });
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: real.chain,
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: real.getName.bind(real),
    getBalance: vi.fn(async () => 1_000_000_000n), // 1000 USDC
    getDomainSeparator: vi.fn(async () => ("0x" + "00".repeat(32)) as Hex),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization: real.signTransferAuthorization.bind(real),
    verifySignedAuthorization: real.verifySignedAuthorization.bind(real),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as Hex),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as SonicTokenClient;
}

function makeConnector(tokenClient?: SonicTokenClient): SonicConnector {
  return new SonicConnector({
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
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: SONIC_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    asset: { symbol: "USDC", decimals: 6, chain: "eip155:57054", contract: TEST_TOKEN },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0x" + "ab".repeat(32),
    rawPayload: {},
    ...overrides,
  };
}

// ============================================================================
//  getCapabilities
// ============================================================================

describe("SonicConnector.getCapabilities", () => {
  it("reports sonic provider", () => {
    const caps = makeConnector(makeStubTokenClient()).getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(SONIC_PROTOCOL);
  });

  it("advertises USDC bound to Sonic Blaze (eip155:57054)", () => {
    const usdc = makeConnector(makeStubTokenClient())
      .getCapabilities()
      .supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.chain).toBe("eip155:57054");
    expect(usdc?.contract).toBe(TEST_TOKEN);
  });

  it("decimals stay within the conformance bound (<= 24)", () => {
    const caps = makeConnector(makeStubTokenClient()).getCapabilities();
    for (const a of caps.supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
  });

  it("exposes chainId 57054", () => {
    expect(makeConnector(makeStubTokenClient()).chainId).toBe(57054);
    expect(SONIC_BLAZE_CHAIN_ID).toBe(57054);
  });

  it("is pure (two calls equal)", () => {
    const c = makeConnector(makeStubTokenClient());
    const a = c.getCapabilities();
    const b = c.getCapabilities();
    expect(a.walletProvider).toBe(b.walletProvider);
    expect(a.supportedAssets.length).toBe(b.supportedAssets.length);
  });
});

// ============================================================================
//  createInstrument
// ============================================================================

describe("SonicConnector.createInstrument", () => {
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
    expect(inst.id).toBe("payment-instrument-sonic-alice");
  });

  it("rejects empty userId", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("generates a fresh in-process keypair when no key supplied", () => {
    const c = new SonicConnector({ instrumentStore: new MemoryInstrumentStore() });
    expect(c.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

// ============================================================================
//  getBalance
// ============================================================================

describe("SonicConnector.getBalance", () => {
  it("returns Balance with stringified atomic units", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(typeof bal.money.amountAtomic).toBe("string");
    expect(BigInt(bal.money.amountAtomic) >= 0n).toBe(true);
    expect(bal.asset.chain).toBe("eip155:57054");
  });

  it("throws on unknown instrument id", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.getBalance("payment-instrument-DOES-NOT-EXIST" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

// ============================================================================
//  signAuthorization — REAL verifiable signature
// ============================================================================

describe("SonicConnector.signAuthorization", () => {
  it("produces a real EIP-712 signature that verifies + recovers to the signer", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userAlice),
    });

    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/);

    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const domain = {
      name: DOMAIN_NAME,
      version: "2",
      chainId: BigInt(SONIC_BLAZE_CHAIN_ID),
      verifyingContract: TEST_TOKEN,
    } as const;
    const message = {
      from: wire.authorization.from,
      to: wire.authorization.to,
      value: BigInt(wire.authorization.value),
      validAfter: BigInt(wire.authorization.validAfter),
      validBefore: BigInt(wire.authorization.validBefore),
      nonce: wire.authorization.nonce,
    };

    // verifyTypedData true for the genuine signature
    const ok = await verifyTypedData({
      address: TEST_AGENT_ADDRESS as Hex,
      domain,
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signed.signature as Hex,
    });
    expect(ok).toBe(true);

    // recover address matches signer
    const recovered = await recoverTypedDataAddress({
      domain,
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signed.signature as Hex,
    });
    expect(recovered.toLowerCase()).toBe(TEST_AGENT_ADDRESS.toLowerCase());
  });

  it("tampered message fails verification (signature bound to exact payload)", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userAlice),
    });
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const domain = {
      name: DOMAIN_NAME,
      version: "2",
      chainId: BigInt(SONIC_BLAZE_CHAIN_ID),
      verifyingContract: TEST_TOKEN,
    } as const;

    // Tamper: change value (1000 -> 999999)
    const tampered = await verifyTypedData({
      address: TEST_AGENT_ADDRESS as Hex,
      domain,
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: wire.authorization.from,
        to: wire.authorization.to,
        value: 999999n,
        validAfter: BigInt(wire.authorization.validAfter),
        validBefore: BigInt(wire.authorization.validBefore),
        nonce: wire.authorization.nonce,
      },
      signature: signed.signature as Hex,
    });
    expect(tampered).toBe(false);
  });

  it("signature does NOT verify against a different signer address", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userAlice),
    });
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const other = privateKeyToAccount(
      "0x0000000000000000000000000000000000000000000000000000000000000002"
    ).address;
    const ok = await verifyTypedData({
      address: other,
      domain: {
        name: DOMAIN_NAME,
        version: "2",
        chainId: BigInt(SONIC_BLAZE_CHAIN_ID),
        verifyingContract: TEST_TOKEN,
      },
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: wire.authorization.from,
        to: wire.authorization.to,
        value: BigInt(wire.authorization.value),
        validAfter: BigInt(wire.authorization.validAfter),
        validBefore: BigInt(wire.authorization.validBefore),
        nonce: wire.authorization.nonce,
      },
      signature: signed.signature as Hex,
    });
    expect(ok).toBe(false);
  });

  it("rejects unsupported protocol", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-v999" as ProtocolId }),
        session: buildSession(userAlice),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrument id", async () => {
    const c = makeConnector(makeStubTokenClient());
    await expect(
      c.signAuthorization({
        instrumentId: "bogus-id" as never,
        request: buildRequest(),
        session: buildSession(userAlice),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

// ============================================================================
//  settle — offline-safe mock + chain mode
// ============================================================================

describe("SonicConnector.settle", () => {
  it("mock mode (default) returns a structurally valid success offline", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userAlice),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(typeof result.network).toBe("string");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect((result.transactionRef as string).length).toBeGreaterThan(0);
  });

  it("fails gracefully with canonical errorCode when signed payload missing", async () => {
    const c = makeConnector(makeStubTokenClient());
    const result = await c.settle({
      request: buildRequest(),
      signer: TEST_AGENT_ADDRESS,
      signature: "0xdeadbeef",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("chain mode broadcasts via token client and returns tx hash", async () => {
    const stub = makeStubTokenClient();
    const c = new SonicConnector({
      privateKey: TEST_PRIVATE_KEY,
      tokenAddress: TEST_TOKEN,
      instrumentStore: new MemoryInstrumentStore(),
      now: () => FIXED_NOW_MS,
      broadcast: "chain",
      tokenClient: stub,
    });
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userAlice),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
  });
});
