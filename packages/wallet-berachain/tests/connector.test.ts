/**
 * Tests for BerachainConnector.
 *
 * Real eth signing (viem PrivateKeyAccount.signTypedData) + stubbed network
 * I/O via a stub BerachainTokenClient. Validates the 5-method WalletConnector
 * contract, the in-process keypair-generation feature, AND real EIP-712
 * signature verification (verify + tampered-fails) using viem verifyTypedData.
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { verifyTypedData, type Address } from "viem";
import {
  type CreateInstrumentInput,
  type PaymentRequest,
  type ProtocolId,
  type SignedAuthorization,
  type UserId,
} from "@openagentpay/core";
import {
  BerachainConnector,
  BERACHAIN_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  BerachainTokenClient,
  EIP712_TYPES,
  type Eip3009SignedAuthorization,
} from "../src/token-client.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x549943e04f40284185054145c6E4e9568C1D3241" as const;
const FIXED_NOW_MS = 1778860654_000;

/**
 * Stub token client whose signTransferAuthorization delegates to a *real*
 * BerachainTokenClient instance (offline, no RPC) so the signature is
 * genuinely verifiable, while balance/broadcast/receipt stay stubbed.
 */
function makeStubTokenClient(): BerachainTokenClient {
  const realForSigning = new BerachainTokenClient({
    tokenAddress: TEST_TOKEN,
    publicClient: {} as never, // never touched — signing needs no RPC when name is passed
  });
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 80084, name: "Berachain bArtio" },
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USDC"),
    getBalance: vi.fn(async () => 1_000_000_000n), // 1000 USDC
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization: realForSigning.signTransferAuthorization.bind(realForSigning),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as BerachainTokenClient;
}

function makeConnector(tokenClient?: BerachainTokenClient): BerachainConnector {
  return new BerachainConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    tokenName: "USDC",
    tokenClient: tokenClient ?? makeStubTokenClient(),
  });
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: BERACHAIN_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: "0x000000000000000000000000000000000000dEaD",
    asset: { symbol: "USDC", decimals: 6, chain: "eip155:80084", contract: TEST_TOKEN },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "0x" + "1".repeat(64),
    rawPayload: {},
    ...overrides,
  };
}

describe("BerachainConnector — getCapabilities", () => {
  it("returns the berachain provider id and x402-v1 protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toEqual([BERACHAIN_PROTOCOL]);
    expect(caps.settlesOnChain).toBe(true);
  });

  it("declares a USDC asset with 6 decimals (<= 24) on eip155:80084", () => {
    const caps = makeConnector().getCapabilities();
    const usdc = caps.supportedAssets[0];
    expect(usdc?.symbol).toBe("USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.decimals).toBeLessThanOrEqual(24);
    expect(usdc?.chain).toBe("eip155:80084");
  });

  it("is pure — repeated calls return equal capabilities", () => {
    const c = makeConnector();
    expect(c.getCapabilities()).toEqual(c.getCapabilities());
  });
});

describe("BerachainConnector — createInstrument", () => {
  it("throws on empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId } as CreateInstrumentInput)
    ).rejects.toThrow(/userId is required/);
  });

  it("creates an instrument with a real 0x address publicHandle", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(inst.publicHandle).toBe(TEST_AGENT_ADDRESS);
  });

  it("is idempotent — same userId returns the same instrument id", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "u2" as UserId });
    const b = await c.createInstrument({ userId: "u2" as UserId });
    expect(a.id).toBe(b.id);
  });
});

describe("BerachainConnector — getBalance", () => {
  it("throws on unknown instrument id", async () => {
    const c = makeConnector();
    await expect(c.getBalance("nope" as never)).rejects.toThrow(/not found/);
  });

  it("returns balance as atomic Money string", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u3" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
  });
});

describe("BerachainConnector — signAuthorization", () => {
  it("throws on wrong protocol", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u4" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "not-x402" as ProtocolId }),
      })
    ).rejects.toThrow(/only supports protocol x402-v1/);
  });

  it("throws on unknown instrument id", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({ instrumentId: "ghost" as never, request: buildRequest() })
    ).rejects.toThrow(/not found/);
  });

  it("produces a real EIP-712 signature recoverable to the agent address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u5" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const ok = await verifyTypedData({
      address: TEST_AGENT_ADDRESS as Address,
      domain: {
        name: "USDC",
        version: "2",
        chainId: 80084n,
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
      signature: wire.signature,
    });
    expect(ok).toBe(true);
  });
});

describe("BerachainConnector — verifyAuthorization", () => {
  it("verifies an untampered signature as valid", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u6" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    expect(await c.verifyAuthorization(signed)).toBe(true);
  });

  it("rejects a tampered signature (mutated recipient/amount)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u7" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });

    // Tamper the signed wire authorization: change the value after signing.
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const tampered: SignedAuthorization = {
      ...signed,
      extra: {
        ...signed.extra,
        signed: {
          ...wire,
          authorization: { ...wire.authorization, value: "999999999" },
        },
      },
    };
    expect(await c.verifyAuthorization(tampered)).toBe(false);
  });

  it("rejects when the signed wire payload is missing", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u8" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    const stripped: SignedAuthorization = { ...signed, extra: {} };
    expect(await c.verifyAuthorization(stripped)).toBe(false);
  });
});

describe("BerachainConnector — settle (stubbed broadcast)", () => {
  it("returns a successful SettlementResult with tx hash + explorer url", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u9" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    const res = await c.settle(signed);
    expect(res.success).toBe(true);
    expect(res.transactionRef).toBe("0xfeedface");
    expect((res.raw as { explorerUrl: string }).explorerUrl).toMatch(/beratrail\.io\/tx\//);
  });

  it("returns signature_invalid when the wire payload is absent", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u10" as UserId });
    const signed = await c.signAuthorization({ instrumentId: inst.id, request: buildRequest() });
    const res = await c.settle({ ...signed, extra: {} });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });
});

describe("BerachainConnector — in-process keypair", () => {
  it("generates a fresh real 0x EOA when no private key is supplied", () => {
    const c = new BerachainConnector({ instrumentStore: new MemoryInstrumentStore() });
    expect(c.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.chainId).toBe(80084);
  });

  it("two fresh connectors get distinct addresses", () => {
    const a = new BerachainConnector({ instrumentStore: new MemoryInstrumentStore() });
    const b = new BerachainConnector({ instrumentStore: new MemoryInstrumentStore() });
    expect(a.agentAddress).not.toBe(b.agentAddress);
  });

  it("generateNonce returns a 32-byte hex", () => {
    const c = makeConnector();
    expect(c.generateNonce()).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
