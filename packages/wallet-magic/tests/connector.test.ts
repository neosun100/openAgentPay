/**
 * Unit tests for @openagentpay/wallet-magic — Magic.link email EVM wallet.
 *
 * Exercises real secp256k1 keygen, email binding, EIP-712 EIP-3009 signing
 * (with cryptographic verification), the full 5-method connector contract,
 * and error paths. Runs fully offline.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  MagicConnector,
  MemoryInstrumentStore,
  RealMagicSigner,
  generateMagicKeypair,
  generateNonce,
  isLikelyEmail,
  WALLET_PROVIDER_ID,
  MAGIC_PROTOCOL,
  BASE_SEPOLIA_USDC,
} from "../src/index.js";
import type {
  InstrumentId,
  PaymentRequest,
  ProtocolId,
  Session,
  UserId,
} from "@openagentpay/core";

const TEST_EMAIL = "agent@openagentpay.dev";
// Throwaway deterministic key (NEVER use for real funds).
const TEST_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

function makeConnector(overrides?: { email?: string }) {
  return new MagicConnector({
    agentEmail: overrides?.email ?? TEST_EMAIL,
    privateKey: TEST_PK,
    instrumentStore: new MemoryInstrumentStore(),
  });
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: MAGIC_PROTOCOL,
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
//  Keygen + email helpers
// ----------------------------------------------------------------------------

describe("generateMagicKeypair", () => {
  it("produces a real checksummed 0x address and 0x private key", () => {
    const kp = generateMagicKeypair();
    expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(kp.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("two keypairs are distinct (randomness)", () => {
    const a = generateMagicKeypair();
    const b = generateMagicKeypair();
    expect(a.address).not.toBe(b.address);
  });
});

describe("isLikelyEmail", () => {
  it("accepts a normal email", () => {
    expect(isLikelyEmail("a@b.com")).toBe(true);
  });
  it("rejects non-emails", () => {
    expect(isLikelyEmail("not-an-email")).toBe(false);
    expect(isLikelyEmail("")).toBe(false);
  });
});

describe("RealMagicSigner constructor", () => {
  it("derives a stable 0x address from a fixed private key", () => {
    const s = new RealMagicSigner({ email: TEST_EMAIL, privateKey: TEST_PK });
    // Known address for TEST_PK (Anvil account #1).
    expect(s.address.toLowerCase()).toBe(
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
    );
    expect(s.email).toBe(TEST_EMAIL);
  });

  it("throws on invalid email", () => {
    expect(() => new RealMagicSigner({ email: "bogus" })).toThrow(/valid email/);
  });
});

// ----------------------------------------------------------------------------
//  Capabilities
// ----------------------------------------------------------------------------

describe("MagicConnector — capabilities", () => {
  it("reports walletProvider=magic and emailBased=true", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(MAGIC_PROTOCOL);
    expect(caps.features?.emailBased).toBe(true);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
//  createInstrument + getBalance
// ----------------------------------------------------------------------------

describe("MagicConnector.createInstrument", () => {
  it("creates an instrument with the 0x address as publicHandle and email in metadata", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(inst.publicHandle.toLowerCase()).toBe(c.walletAddress.toLowerCase());
    expect(inst.providerMetadata?.["email"]).toBe(TEST_EMAIL);
    expect(inst.providerMetadata?.["network"]).toBe("base-sepolia");
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
    const c = new MagicConnector({
      agentEmail: TEST_EMAIL,
      privateKey: TEST_PK,
      instrumentStore: new MemoryInstrumentStore(),
      balanceReader: async () => 5_000_000n,
    });
    const inst = await c.createInstrument({ userId: "bob" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("5000000");
  });

  it("getBalance throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(c.getBalance("nope" as InstrumentId)).rejects.toThrow(
      /not found/
    );
  });
});

// ----------------------------------------------------------------------------
//  signAuthorization — real EIP-712 signature
// ----------------------------------------------------------------------------

describe("MagicConnector.signAuthorization", () => {
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
    expect(signed.extra?.["email"]).toBe(TEST_EMAIL);

    // Cryptographically verify the signature recovers to the signer address.
    const signer = new RealMagicSigner({ email: TEST_EMAIL, privateKey: TEST_PK });
    const wire = signed.extra?.["signed"] as Parameters<
      RealMagicSigner["verify"]
    >[0];
    expect(await signer.verify(wire)).toBe(true);
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

describe("MagicConnector.settle", () => {
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
    const c = new MagicConnector({
      agentEmail: TEST_EMAIL,
      privateKey: TEST_PK,
      instrumentStore: new MemoryInstrumentStore(),
      submit: async () => ({
        transactionHash: "0xabc123",
        blockNumber: 777,
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
    expect(res.transactionRef).toBe("0xabc123");
    expect((res.raw as { explorerUrl: string }).explorerUrl).toContain(
      "sepolia.basescan.org/tx/0xabc123"
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

describe("MagicConnector helpers", () => {
  it("generateNonce produces a 32-byte 0x hex", () => {
    expect(makeConnector().generateNonce()).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(generateNonce()).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("two connectors with different emails but same key share the address but differ on email", async () => {
    const c1 = makeConnector({ email: "one@x.com" });
    const c2 = makeConnector({ email: "two@x.com" });
    expect(c1.walletAddress).toBe(c2.walletAddress);
    expect(c1.email).not.toBe(c2.email);
  });
});
