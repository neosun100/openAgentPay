/**
 * Tests for RoninSaigonConnector + RoninTokenClient.
 *
 * Real eth signing + ecrecover verification (viem) with stubbed network I/O.
 * Validates the 5-method WalletConnector contract, the in-process keypair
 * feature, Ronin display-address handling, a REAL verifiable signature with a
 * tampered-fails counter-test, and the offline MockBroadcaster settle path.
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CreateInstrumentInput,
  type PaymentRequest,
  type ProtocolId,
  type UserId,
} from "@openagentpay/core";
import {
  RoninSaigonConnector,
  RONIN_PROTOCOL,
  MemoryInstrumentStore,
  MockBroadcaster,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  RoninTokenClient,
  type Eip3009SignedAuthorization,
} from "../src/token-client.js";
import {
  RONIN_SAIGON_CHAIN_ID,
  RONIN_SAIGON_USDC,
  fromRoninDisplay,
  toRoninDisplay,
} from "../src/chain.js";

// Throwaway test private key — address 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TOKEN = "0x067FBFf8990c58Ab90BaE3c97241C5d736053F77" as const;
const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): RoninTokenClient {
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: RONIN_SAIGON_CHAIN_ID, name: "Ronin Saigon Testnet" },
    publicClient: {} as never,
    domainVersion: "2",
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "USD Coin"),
    getBalance: vi.fn(async () => 1_000_000_000n),
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization:
      RoninTokenClient.prototype.signTransferAuthorization,
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  stub.signTransferAuthorization = stub.signTransferAuthorization.bind(stub);
  return stub as unknown as RoninTokenClient;
}

function makeConnector(tokenClient?: RoninTokenClient): RoninSaigonConnector {
  return new RoninSaigonConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    tokenClient: tokenClient ?? makeStubTokenClient(),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: RONIN_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: "0x000000000000000000000000000000000000dEaD",
    asset: { symbol: "USDC", decimals: 6, chain: "eip155:2021", contract: TEST_TOKEN },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0x" + "1".repeat(64),
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("RoninSaigonConnector.getCapabilities", () => {
  it("reports the ronin provider + x402-v1 protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedProtocols).toContain(RONIN_PROTOCOL);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
  });

  it("advertises USDC bound to Ronin Saigon (eip155:2021, 6 decimals)", () => {
    const usdc = makeConnector()
      .getCapabilities()
      .supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.chain).toBe(`eip155:${RONIN_SAIGON_CHAIN_ID}`);
    expect(usdc?.contract).toBe(RONIN_SAIGON_USDC);
    // Asset decimals must satisfy the <=24 core constraint.
    expect(usdc?.decimals).toBeLessThanOrEqual(24);
  });

  it("getCapabilities is pure (stable across calls)", () => {
    const c = makeConnector();
    expect(c.getCapabilities()).toEqual(c.getCapabilities());
  });
});

describe("RoninSaigonConnector.createInstrument", () => {
  it("creates an instrument bound to the agent 0x address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    expect(inst.userId).toBe(userAlice);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(TEST_AGENT_ADDRESS);
  });

  it("is idempotent for the same userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
  });

  it("rejects an empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("records the ronin: display address in providerMetadata", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    expect(inst.providerMetadata?.["roninAddress"]).toBe(
      toRoninDisplay(TEST_AGENT_ADDRESS)
    );
  });
});

describe("RoninSaigonConnector.getBalance", () => {
  it("returns USDC balance for a known instrument", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.currency).toBe("USDC");
    expect(bal.asset.decimals).toBe(6);
  });

  it("throws on an unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-ronin-nope" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("RoninSaigonConnector.signAuthorization", () => {
  it("produces a REAL verifiable EIP-712 signature", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    // Independently verify via ecrecover (not just the connector's self-check).
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    expect(await RoninTokenClient.verifySignedAuthorization(wire)).toBe(true);
  });

  it("tampered authorization FAILS verification", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
    });
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;

    // Tamper with the value — recovered signer will no longer match `from`.
    const tampered: Eip3009SignedAuthorization = {
      ...wire,
      authorization: { ...wire.authorization, value: "999999999" },
    };
    expect(await RoninTokenClient.verifySignedAuthorization(tampered)).toBe(false);
  });

  it("tampered signature byte FAILS verification", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
    });
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const flipped = (wire.signature.slice(0, -2) +
      (wire.signature.slice(-2) === "00" ? "01" : "00")) as `0x${string}`;
    const tampered: Eip3009SignedAuthorization = { ...wire, signature: flipped };
    expect(await RoninTokenClient.verifySignedAuthorization(tampered)).toBe(false);
  });

  it("rejects the wrong protocol id", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "tap-v2" as ProtocolId }),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on an unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-ronin-nope" as never,
        request: buildRequest(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("RoninSaigonConnector.settle", () => {
  it("settles successfully via the offline MockBroadcaster", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toMatch(/^0x[0-9a-fA-F]+$/);
    expect((result.raw as Record<string, unknown>)["explorerUrl"]).toMatch(
      /saigon-app\.roninchain\.com\/tx\//
    );
  });

  it("fails settle when signed.extra.signed is missing", async () => {
    const c = makeConnector();
    const result = await c.settle({
      request: buildRequest(),
      signer: TEST_AGENT_ADDRESS as never,
      signature: "0xdeadbeef" as never,
      extra: {},
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("fails settle when the signature is tampered", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
    });
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const result = await c.settle({
      ...signed,
      extra: {
        ...signed.extra,
        signed: { ...wire, authorization: { ...wire.authorization, value: "1" } },
      },
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});

describe("RoninSaigonConnector keypair + Ronin address handling", () => {
  it("generates a fresh in-process EVM keypair when no key is supplied", () => {
    const c = new RoninSaigonConnector({
      instrumentStore: new MemoryInstrumentStore(),
      tokenClient: makeStubTokenClient(),
    });
    expect(c.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.chainId).toBe(RONIN_SAIGON_CHAIN_ID);
  });

  it("exposes the ronin: display address and round-trips to 0x", () => {
    const c = makeConnector();
    expect(c.roninDisplayAddress).toBe(`ronin:${TEST_AGENT_ADDRESS.slice(2)}`);
    expect(fromRoninDisplay(c.roninDisplayAddress).toLowerCase()).toBe(
      TEST_AGENT_ADDRESS.toLowerCase()
    );
  });

  it("MockBroadcaster yields a deterministic 0x tx hash from the signature", async () => {
    const bc = new MockBroadcaster();
    const fake = {
      signature: ("0x" + "ab".repeat(65)) as `0x${string}`,
    } as Eip3009SignedAuthorization;
    const out = await bc.broadcast(fake);
    expect(out.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
