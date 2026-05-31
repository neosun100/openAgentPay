/**
 * AlgorandConnector + RealAlgorandSigner unit tests.
 *
 * Covers: capabilities, address codec (keygen / encode / decode / validate),
 * createInstrument (idempotent + empty-userId reject), getBalance (+ unknown
 * id), signAuthorization (real sig + protocol/instrument guards), settle,
 * and the sign→verify→tamper cryptographic round-trip.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type {
  InstrumentId,
  PaymentRequest,
  ProtocolId,
  Session,
  SessionId,
  UserId,
} from "@openagentpay/core";
import {
  AlgorandConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  RealAlgorandSigner,
  generateAlgorandKeypair,
  keypairFromSeed,
  keypairFromHex,
  encodeAlgorandAddress,
  decodeAlgorandAddress,
  isValidAlgorandAddress,
  canonicalTransferDescriptor,
} from "../src/index.js";

const SEED = new Uint8Array(32).fill(9);

function makeConnector(signer = new RealAlgorandSigner({ seed: SEED, network: "testnet" })) {
  return new AlgorandConnector({
    signer,
    instrumentStore: new MemoryInstrumentStore(),
    network: "testnet",
  });
}

function buildSession(userId: UserId): Session {
  const now = new Date();
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

const RECIPIENT = generateAlgorandKeypair().address;

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: RECIPIENT,
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Address codec / keygen
// ---------------------------------------------------------------------------

describe("Algorand address codec", () => {
  it("generates a 58-char uppercase base32 address", () => {
    const kp = generateAlgorandKeypair();
    expect(kp.address.length).toBe(58);
    expect(kp.address).toBe(kp.address.toUpperCase());
    expect(/^[A-Z2-7]{58}$/.test(kp.address)).toBe(true);
  });

  it("is deterministic from a fixed seed", () => {
    const a = keypairFromSeed(SEED);
    const b = keypairFromSeed(SEED);
    expect(a.address).toBe(b.address);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
  });

  it("keypairFromHex round-trips the seed", () => {
    const kp = generateAlgorandKeypair();
    const again = keypairFromHex(kp.secretSeedHex);
    expect(again.address).toBe(kp.address);
  });

  it("decodeAlgorandAddress recovers the exact pubkey", () => {
    const kp = generateAlgorandKeypair();
    const pub = decodeAlgorandAddress(kp.address);
    expect(encodeAlgorandAddress(pub)).toBe(kp.address);
  });

  it("rejects tampered addresses (checksum mismatch)", () => {
    const kp = generateAlgorandKeypair();
    // Flip one char in the pubkey body (keep length 58).
    const ch = kp.address[0] === "A" ? "B" : "A";
    const tampered = ch + kp.address.slice(1);
    expect(isValidAlgorandAddress(tampered)).toBe(false);
    expect(() => decodeAlgorandAddress(tampered)).toThrow();
  });

  it("rejects wrong-length and lowercased addresses", () => {
    const kp = generateAlgorandKeypair();
    expect(isValidAlgorandAddress(kp.address.slice(0, 57))).toBe(false);
    expect(isValidAlgorandAddress(kp.address.toLowerCase())).toBe(false);
  });

  it("encodeAlgorandAddress throws on non-32-byte pubkey", () => {
    expect(() => encodeAlgorandAddress(new Uint8Array(31))).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  Capabilities
// ---------------------------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports algorand provider, ALGO+USDC assets, the protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    const symbols = caps.supportedAssets.map((a) => a.symbol);
    expect(symbols).toContain("ALGO");
    expect(symbols).toContain("USDC");
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["ed25519"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("binds the signer address as publicHandle", async () => {
    const signer = new RealAlgorandSigner({ seed: SEED, network: "testnet" });
    const c = makeConnector(signer);
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle).toBe(signer.address);
    expect(inst.publicHandle.length).toBe(58);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("is idempotent per userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "same" as UserId });
    const b = await c.createInstrument({ userId: "same" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("throws when userId is empty", async () => {
    const c = makeConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(
      /userId is required/
    );
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("getBalance()", () => {
  it("returns 0 atomic by default (offline-safe)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("USDC");
    expect(BigInt(bal.money.amountAtomic) >= 0n).toBe(true);
  });

  it("reads through a supplied balanceReader", async () => {
    const signer = new RealAlgorandSigner({
      seed: SEED,
      network: "testnet",
      balanceReader: async () => 4200000n,
    });
    const c = makeConnector(signer);
    const inst = await c.createInstrument({ userId: "bal2" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("4200000");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable Ed25519 signature", async () => {
    const signer = new RealAlgorandSigner({ seed: SEED, network: "testnet" });
    const c = makeConnector(signer);
    const userId = "signer-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signer).toBe(signer.address);
    // Verify against the descriptor the connector reconstructs.
    const descriptor = c.descriptorFor(signed);
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("tampered message fails verification", async () => {
    const signer = new RealAlgorandSigner({ seed: SEED, network: "testnet" });
    const c = makeConnector(signer);
    const userId = "tamper" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const tamperedDescriptor =
      c.descriptorFor(signed) + "\nEXTRA=injected";
    expect(signer.verify(signed.signature, tamperedDescriptor)).toBe(false);
  });

  it("rejects mismatched protocol", async () => {
    const c = makeConnector();
    const userId = "wrong-proto" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "x402-v1" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/only supports/);
  });

  it("rejects unknown instrumentId", async () => {
    const c = makeConnector();
    const userId = "no-inst" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("settle()", () => {
  it("returns success with a transactionRef and ISO settledAt", async () => {
    const c = makeConnector();
    const userId = "settle-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.success).toBe(true);
    expect(res.network).toBe("algorand-testnet");
    expect(res.transactionRef && res.transactionRef.length > 0).toBe(true);
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("fails gracefully on a signature-less authorization", async () => {
    const c = makeConnector();
    const userId = "settle-bad" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await c.settle({ ...signed, signature: "" });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });

  it("routes through a submit hook when present (real txId)", async () => {
    const signer = new RealAlgorandSigner({
      seed: SEED,
      network: "testnet",
      submit: async () => ({ txId: "REALTXID123", round: 99 }),
    });
    const c = makeConnector(signer);
    const userId = "submit-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.transactionRef).toBe("REALTXID123");
  });
});

// ---------------------------------------------------------------------------
//  Descriptor / signer direct
// ---------------------------------------------------------------------------

describe("canonicalTransferDescriptor + signer", () => {
  it("descriptor is stable for identical inputs", () => {
    const a = canonicalTransferDescriptor({
      from: "A",
      to: "B",
      amountAtomic: "10",
    });
    const b = canonicalTransferDescriptor({
      from: "A",
      to: "B",
      amountAtomic: "10",
    });
    expect(a).toBe(b);
  });

  it("verify() returns false on malformed signature input", () => {
    const signer = new RealAlgorandSigner({ seed: SEED });
    expect(signer.verify("!!!not-base64!!!", "anything")).toBe(false);
  });
});
