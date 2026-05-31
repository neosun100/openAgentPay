/**
 * Unit tests for @openagentpay/wallet-stellar — connector behavior, StrKey
 * keygen/codec correctness, real Ed25519 sign+verify, and error paths.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type { InstrumentId, PaymentRequest, ProtocolId, Session, SessionId, UserId } from "@openagentpay/core";
import {
  StellarConnector,
  MemoryInstrumentStore,
  DemoStellarSigner,
  PROTOCOL_ID,
  RealStellarSigner,
  generateStellarKeypair,
  keypairFromSeed,
  keypairFromSecret,
  canonicalTransferDescriptor,
  encodeAccountId,
  decodeAccountId,
  isValidAccountId,
  crc16xmodem,
  decimalToAtomic,
} from "../src/index.js";

const TEST_SEED = new Uint8Array(32).fill(7);

function makeConnector(signer = new RealStellarSigner({ seed: TEST_SEED, network: "testnet" })) {
  return new StellarConnector({
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
    budget: { amountAtomic: "1000000000", decimals: 7, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 7, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "15000000", decimals: 7, currency: "USDC" },
    recipient: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    asset: { symbol: "USDC", decimals: 7 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "MEMO_1",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  StrKey keygen + codec
// ---------------------------------------------------------------------------

describe("StrKey keygen + codec", () => {
  it("generates a real 'G...' account id of length 56", () => {
    const kp = generateStellarKeypair();
    expect(kp.address.startsWith("G")).toBe(true);
    expect(kp.address.length).toBe(56);
    expect(isValidAccountId(kp.address)).toBe(true);
  });

  it("generates a real 'S...' secret of length 56", () => {
    const kp = generateStellarKeypair();
    expect(kp.secret.startsWith("S")).toBe(true);
    expect(kp.secret.length).toBe(56);
  });

  it("is deterministic from a fixed seed", () => {
    const a = keypairFromSeed(TEST_SEED);
    const b = keypairFromSeed(TEST_SEED);
    expect(a.address).toBe(b.address);
    expect(a.secret).toBe(b.secret);
  });

  it("round-trips secret → keypair → same address", () => {
    const kp = keypairFromSeed(TEST_SEED);
    const recovered = keypairFromSecret(kp.secret);
    expect(recovered.address).toBe(kp.address);
  });

  it("encodeAccountId/decodeAccountId round-trips the raw pubkey", () => {
    const kp = keypairFromSeed(TEST_SEED);
    const raw = decodeAccountId(kp.address);
    expect(raw.length).toBe(32);
    expect(encodeAccountId(raw)).toBe(kp.address);
  });

  it("rejects an address with a corrupted checksum", () => {
    const kp = generateStellarKeypair();
    const tampered = kp.address.slice(0, -2) + (kp.address.endsWith("AA") ? "BB" : "AA");
    expect(isValidAccountId(tampered)).toBe(false);
  });

  it("crc16xmodem matches a known test vector ('123456789' = 0x31C3)", () => {
    const data = new TextEncoder().encode("123456789");
    expect(crc16xmodem(data)).toBe(0x31c3);
  });
});

// ---------------------------------------------------------------------------
//  decimalToAtomic
// ---------------------------------------------------------------------------

describe("decimalToAtomic (7 decimals)", () => {
  it("converts 1.5 → 15000000", () => {
    expect(decimalToAtomic("1.5")).toBe("15000000");
  });
  it("converts whole 10 → 100000000", () => {
    expect(decimalToAtomic("10")).toBe("100000000");
  });
  it("truncates excess precision", () => {
    expect(decimalToAtomic("0.123456789")).toBe("1234567");
  });
  it("throws on garbage input", () => {
    expect(() => decimalToAtomic("abc")).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  getCapabilities
// ---------------------------------------------------------------------------

describe("getCapabilities", () => {
  it("reports stellar provider, sep31 protocol, 7-decimal assets", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe("stellar");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.every((a) => a.decimals === 7)).toBe(true);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["ed25519"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument", () => {
  it("creates an instrument whose publicHandle is the signer's 'G...' address", async () => {
    const signer = new RealStellarSigner({ seed: TEST_SEED, network: "testnet" });
    const conn = makeConnector(signer);
    const inst = await conn.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle).toBe(signer.address);
    expect(inst.publicHandle.startsWith("G")).toBe(true);
    expect(inst.walletProvider).toBe("stellar");
  });

  it("is idempotent per userId", async () => {
    const conn = makeConnector();
    const a = await conn.createInstrument({ userId: "u-idem" as UserId });
    const b = await conn.createInstrument({ userId: "u-idem" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("rejects empty userId", async () => {
    const conn = makeConnector();
    await expect(conn.createInstrument({ userId: "" as UserId })).rejects.toThrow(
      /userId is required/
    );
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("getBalance", () => {
  it("returns a Balance with 7-decimal USDC and a valid timestamp", async () => {
    const signer = new RealStellarSigner({
      seed: TEST_SEED,
      network: "testnet",
      balanceReader: async () => 42_0000000n,
    });
    const conn = makeConnector(signer);
    const inst = await conn.createInstrument({ userId: "bal-u" as UserId });
    const bal = await conn.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("420000000");
    expect(bal.money.decimals).toBe(7);
    expect(bal.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws on unknown instrumentId", async () => {
    const conn = makeConnector();
    await expect(conn.getBalance("nope" as InstrumentId)).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization (real Ed25519)
// ---------------------------------------------------------------------------

describe("signAuthorization", () => {
  it("produces a real, verifiable Ed25519 signature", async () => {
    const signer = new RealStellarSigner({ seed: TEST_SEED, network: "testnet" });
    const conn = makeConnector(signer);
    const inst = await conn.createInstrument({ userId: "sign-u" as UserId });
    const req = buildRequest();
    const signed = await conn.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession("sign-u" as UserId),
    });
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signer).toBe(signer.address);

    // Reconstruct the exact descriptor the connector signed and verify it.
    const descriptor = canonicalTransferDescriptor({
      network: "testnet",
      from: signer.address,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      assetCode: "USDC",
      assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      memo: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
    // A different message must NOT verify against the same signature.
    expect(signer.verify(signed.signature, descriptor + "tampered")).toBe(false);
  });

  it("handles native XLM (no issuer) and still verifies", async () => {
    const signer = new RealStellarSigner({ seed: TEST_SEED, network: "testnet" });
    const conn = makeConnector(signer);
    const inst = await conn.createInstrument({ userId: "xlm-u" as UserId });
    const req = buildRequest({
      asset: { symbol: "XLM", decimals: 7 },
      amount: { amountAtomic: "30000000", decimals: 7, currency: "XLM" },
    });
    const signed = await conn.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession("xlm-u" as UserId),
    });
    const descriptor = canonicalTransferDescriptor({
      network: "testnet",
      from: signer.address,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      memo: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("rejects a mismatched protocol", async () => {
    const conn = makeConnector();
    const inst = await conn.createInstrument({ userId: "proto-u" as UserId });
    await expect(
      conn.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "x402-v1" as ProtocolId }),
        session: buildSession("proto-u" as UserId),
      })
    ).rejects.toThrow(/stellar-sep31-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const conn = makeConnector();
    await expect(
      conn.signAuthorization({
        instrumentId: "ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession("ghost-u" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("settle", () => {
  it("returns success + transactionRef + ISO settledAt (offline path → sig ref)", async () => {
    const conn = makeConnector();
    const inst = await conn.createInstrument({ userId: "settle-u" as UserId });
    const signed = await conn.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("settle-u" as UserId),
    });
    const res = await conn.settle(signed);
    expect(res.success).toBe(true);
    expect(res.network).toBe("stellar-testnet");
    expect(typeof res.transactionRef).toBe("string");
    expect((res.transactionRef as string).length).toBeGreaterThan(0);
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("prefers the broadcast tx hash over the raw signature when submit hook ran", async () => {
    const signer = new RealStellarSigner({
      seed: TEST_SEED,
      network: "testnet",
      submit: async () => ({ hash: "REAL_LEDGER_HASH", ledger: 99 }),
    });
    const conn = makeConnector(signer);
    const inst = await conn.createInstrument({ userId: "sub-u" as UserId });
    const signed = await conn.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("sub-u" as UserId),
    });
    const res = await conn.settle(signed);
    expect(res.transactionRef).toBe("REAL_LEDGER_HASH");
  });

  it("fails with signature_invalid when signature is empty", async () => {
    const conn = makeConnector();
    const res = await conn.settle({
      request: buildRequest(),
      signer: "G...",
      signature: "",
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });
});

// ---------------------------------------------------------------------------
//  DemoStellarSigner sanity
// ---------------------------------------------------------------------------

describe("DemoStellarSigner", () => {
  it("works as a drop-in signer for the connector", async () => {
    const signer = new DemoStellarSigner({ initialBalanceAtomic: "100" });
    const conn = new StellarConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });
    const inst = await conn.createInstrument({ userId: "demo-u" as UserId });
    const bal = await conn.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("100");
  });
});
