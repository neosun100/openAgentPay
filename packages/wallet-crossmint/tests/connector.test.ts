/**
 * Unit tests for @openagentpay/wallet-crossmint — Crossmint NFT-aware embedded
 * EVM wallet.
 *
 * Exercises deterministic secp256k1 keygen from project credentials, the
 * EIP-712 EIP-3009 signing path (with cryptographic verification AND a
 * tamper-detection assertion), the full 5-method connector contract, and error
 * paths. Runs fully offline.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  CrossmintConnector,
  MemoryInstrumentStore,
  RealCrossmintSigner,
  generateCrossmintKeypair,
  deriveCrossmintPrivateKey,
  generateNonce,
  WALLET_PROVIDER_ID,
  CROSSMINT_PROTOCOL,
} from "../src/index.js";
import type {
  CrossmintSignedAuthorization,
  Eip3009Authorization,
  Eip712Domain,
} from "../src/index.js";
import type {
  InstrumentId,
  PaymentRequest,
  ProtocolId,
  Session,
  UserId,
} from "@openagentpay/core";

const TEST_API_KEY = "sk_test_crossmint_mock_apikey";
const TEST_PROJECT_ID = "proj_unit_0001";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

function makeConnector(overrides?: {
  apiKey?: string;
  projectId?: string;
}) {
  return new CrossmintConnector({
    apiKey: overrides?.apiKey ?? TEST_API_KEY,
    projectId: overrides?.projectId ?? TEST_PROJECT_ID,
    instrumentStore: new MemoryInstrumentStore(),
  });
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: CROSSMINT_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: RECIPIENT,
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "0x" + "1".repeat(64),
    rawPayload: {},
    ...overrides,
  };
}

const FAKE_SESSION = {} as Session;

// ----------------------------------------------------------------------------
//  Keygen — deterministic derivation from project credentials
// ----------------------------------------------------------------------------

describe("generateCrossmintKeypair", () => {
  it("produces a real checksummed 0x address and 0x private key", () => {
    const kp = generateCrossmintKeypair(TEST_API_KEY, TEST_PROJECT_ID);
    expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(kp.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("is deterministic: same creds → same wallet", () => {
    const a = generateCrossmintKeypair(TEST_API_KEY, TEST_PROJECT_ID);
    const b = generateCrossmintKeypair(TEST_API_KEY, TEST_PROJECT_ID);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it("different creds → different wallet", () => {
    const a = generateCrossmintKeypair(TEST_API_KEY, TEST_PROJECT_ID);
    const b = generateCrossmintKeypair(TEST_API_KEY, "proj_OTHER");
    const c = generateCrossmintKeypair("sk_test_OTHER", TEST_PROJECT_ID);
    expect(a.address).not.toBe(b.address);
    expect(a.address).not.toBe(c.address);
  });

  it("deriveCrossmintPrivateKey rejects empty creds", () => {
    expect(() => deriveCrossmintPrivateKey("", TEST_PROJECT_ID)).toThrow(
      /apiKey is required/
    );
    expect(() => deriveCrossmintPrivateKey(TEST_API_KEY, "")).toThrow(
      /projectId is required/
    );
  });
});

describe("RealCrossmintSigner constructor", () => {
  it("derives a stable 0x address for fixed credentials and exposes projectId", () => {
    const s = new RealCrossmintSigner({
      apiKey: TEST_API_KEY,
      projectId: TEST_PROJECT_ID,
    });
    const again = new RealCrossmintSigner({
      apiKey: TEST_API_KEY,
      projectId: TEST_PROJECT_ID,
    });
    expect(s.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(s.address).toBe(again.address);
    expect(s.projectId).toBe(TEST_PROJECT_ID);
  });

  it("throws on missing apiKey or projectId", () => {
    expect(
      () =>
        new RealCrossmintSigner({ apiKey: "", projectId: TEST_PROJECT_ID })
    ).toThrow(/apiKey/);
    expect(
      () => new RealCrossmintSigner({ apiKey: TEST_API_KEY, projectId: "" })
    ).toThrow(/projectId/);
  });
});

// ----------------------------------------------------------------------------
//  Capabilities
// ----------------------------------------------------------------------------

describe("CrossmintConnector — capabilities", () => {
  it("reports walletProvider=crossmint, nftAware=true, embedded=true", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(CROSSMINT_PROTOCOL);
    expect(caps.features?.nftAware).toBe(true);
    expect(caps.features?.embedded).toBe(true);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
//  createInstrument + getBalance
// ----------------------------------------------------------------------------

describe("CrossmintConnector.createInstrument", () => {
  it("creates an instrument with the 0x address as publicHandle and projectId in metadata", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(inst.publicHandle.toLowerCase()).toBe(c.walletAddress.toLowerCase());
    expect(inst.providerMetadata?.["projectId"]).toBe(TEST_PROJECT_ID);
    expect(inst.providerMetadata?.["network"]).toBe("base-sepolia");
    expect(inst.providerMetadata?.["nftAware"]).toBe(true);
    // Secret must NOT leak into metadata — only provenance.
    expect(inst.providerMetadata?.["apiKey"]).toBeUndefined();
    expect(inst.providerMetadata?.["apiKeyConfigured"]).toBe(true);
  });

  it("is idempotent for the same userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "alice" as UserId });
    const b = await c.createInstrument({ userId: "alice" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("throws on empty userId", async () => {
    const c = makeConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(
      /userId is required/
    );
  });

  it("getBalance returns USDC atomic units (0 offline) for a known instrument", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.currency).toBe("USDC");
    expect(bal.money.decimals).toBe(6);
    expect(() => BigInt(bal.money.amountAtomic)).not.toThrow();
  });

  it("getBalance reads through a custom balanceReader", async () => {
    const c = new CrossmintConnector({
      apiKey: TEST_API_KEY,
      projectId: TEST_PROJECT_ID,
      instrumentStore: new MemoryInstrumentStore(),
      balanceReader: async () => 7_500_000n,
    });
    const inst = await c.createInstrument({ userId: "bob" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("7500000");
  });

  it("getBalance throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(c.getBalance("nope" as InstrumentId)).rejects.toThrow(
      /not found/
    );
  });
});

// ----------------------------------------------------------------------------
//  signAuthorization — real EIP-712 signature + tamper detection
// ----------------------------------------------------------------------------

describe("CrossmintConnector.signAuthorization", () => {
  it("produces a real, verifiable EIP-712 EIP-3009 signature", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: FAKE_SESSION,
    });
    expect(signed.signer).toBe(c.walletAddress);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signed.signature.length).toBeGreaterThan(2);
    expect(signed.extra?.["projectId"]).toBe(TEST_PROJECT_ID);
    expect(signed.extra?.["nftAware"]).toBe(true);

    // Cryptographically verify the signature recovers to the signer address.
    const signer = new RealCrossmintSigner({
      apiKey: TEST_API_KEY,
      projectId: TEST_PROJECT_ID,
    });
    const wire = signed.extra?.["signed"] as CrossmintSignedAuthorization;
    expect(await signer.verify(wire)).toBe(true);
  });

  it("a tampered message FAILS verification (signature is real, not a stub)", async () => {
    const signer = new RealCrossmintSigner({
      apiKey: TEST_API_KEY,
      projectId: TEST_PROJECT_ID,
    });
    const authorization: Eip3009Authorization = {
      from: signer.address,
      to: RECIPIENT as `0x${string}`,
      value: "1000",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: ("0x" + "2".repeat(64)) as `0x${string}`,
    };
    const domain: Eip712Domain = {
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract:
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
    };
    const signed = await signer.signTransferAuthorization(authorization, domain);
    expect(await signer.verify(signed)).toBe(true);

    // Tamper with the value — verification must now fail.
    const tampered: CrossmintSignedAuthorization = {
      ...signed,
      authorization: { ...signed.authorization, value: "999999" },
    };
    expect(await signer.verify(tampered)).toBe(false);
  });

  it("rejects a request whose protocol is not x402-v1", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-proto-v9" as ProtocolId }),
        session: FAKE_SESSION,
      })
    ).rejects.toThrow(/only supports protocol x402-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "missing" as InstrumentId,
        request: buildRequest(),
        session: FAKE_SESSION,
      })
    ).rejects.toThrow(/not found/);
  });
});

// ----------------------------------------------------------------------------
//  settle — offline-safe default + pluggable broadcast
// ----------------------------------------------------------------------------

describe("CrossmintConnector.settle", () => {
  it("offline-safe default reports rpc_error (no funds move, no broadcast hook)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: FAKE_SESSION,
    });
    const res = await c.settle(signed);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("rpc_error");
    expect(res.network).toBe("base-sepolia");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("broadcasts on-chain through the pluggable submit hook", async () => {
    const c = new CrossmintConnector({
      apiKey: TEST_API_KEY,
      projectId: TEST_PROJECT_ID,
      instrumentStore: new MemoryInstrumentStore(),
      submit: async () => ({
        transactionHash: "0xfeed",
        blockNumber: 4242,
      }),
    });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: FAKE_SESSION,
    });
    const res = await c.settle(signed);
    expect(res.success).toBe(true);
    expect(res.transactionRef).toBe("0xfeed");
    expect((res.raw as { explorerUrl: string }).explorerUrl).toContain(
      "sepolia.basescan.org/tx/0xfeed"
    );
  });

  it("returns signature_invalid when extra.signed is missing", async () => {
    const c = makeConnector();
    const res = await c.settle({
      request: buildRequest(),
      signer: c.walletAddress,
      signature: "",
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });
});

// ----------------------------------------------------------------------------
//  Misc
// ----------------------------------------------------------------------------

describe("CrossmintConnector helpers", () => {
  it("generateNonce produces a 32-byte 0x hex", () => {
    expect(makeConnector().generateNonce()).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(generateNonce()).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("two connectors with same creds share the same agent wallet address", async () => {
    const c1 = makeConnector();
    const c2 = makeConnector();
    expect(c1.walletAddress).toBe(c2.walletAddress);
    expect(c1.projectId).toBe(c2.projectId);
  });
});
