/**
 * NEAR wallet connector unit tests.
 *
 * Covers: keygen + address format, capabilities, createInstrument (idempotency
 * + empty-userId rejection), getBalance, signAuthorization (real Ed25519 sig +
 * verify + tamper rejection + protocol mismatch + unknown instrument), settle.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type {
  InstrumentId,
  PaymentRequest,
  Session,
  SessionId,
  UserId,
  ProtocolId,
} from "@openagentpay/core";
import {
  NearConnector,
  DemoNearSigner,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  NEAR_DECIMALS,
  USDC_DECIMALS,
  RealNearSigner,
  generateNearKeypair,
  keypairFromSeed,
  keypairFromSecretKey,
  canonicalTransferDescriptor,
} from "../src/index.js";

// ---------------------------------------------------------------------------
//  Test helpers
// ---------------------------------------------------------------------------

const TEST_SEED = new Uint8Array(32).fill(7);

function makeConnector(signer = new RealNearSigner({ seed: TEST_SEED })) {
  return new NearConnector({
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
    budget: { amountAtomic: "1000000000", decimals: USDC_DECIMALS, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: USDC_DECIMALS, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000000", decimals: NEAR_DECIMALS, currency: "NEAR" },
    recipient: "merchant.testnet",
    asset: { symbol: "NEAR", decimals: NEAR_DECIMALS },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Keypair / address format
// ---------------------------------------------------------------------------

describe("NEAR keypair generation", () => {
  it("generates an implicit account = 64 lowercase hex chars (no 0x)", () => {
    const kp = generateNearKeypair();
    expect(kp.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.accountId.startsWith("0x")).toBe(false);
  });

  it("private key string starts with ed25519:", () => {
    const kp = generateNearKeypair();
    expect(kp.secretKey.startsWith("ed25519:")).toBe(true);
    expect(kp.publicKey.startsWith("ed25519:")).toBe(true);
  });

  it("is deterministic from a fixed seed", () => {
    const a = keypairFromSeed(TEST_SEED);
    const b = keypairFromSeed(TEST_SEED);
    expect(a.accountId).toBe(b.accountId);
    expect(a.secretKey).toBe(b.secretKey);
  });

  it("round-trips through keypairFromSecretKey", () => {
    const kp = generateNearKeypair();
    const reloaded = keypairFromSecretKey(kp.secretKey);
    expect(reloaded.accountId).toBe(kp.accountId);
    expect(reloaded.publicKey).toBe(kp.publicKey);
  });

  it("rejects a 32-byte seed of wrong length", () => {
    expect(() => keypairFromSeed(new Uint8Array(31))).toThrow();
  });

  it("rejects a secret key missing the ed25519: prefix", () => {
    expect(() => keypairFromSecretKey("notaprefix")).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  Capabilities
// ---------------------------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports the near provider and near-pay-v1 protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
  });

  it("exposes USDC (6dp) as the payment asset; native NEAR (24dp) via feature flag", () => {
    const caps = makeConnector().getCapabilities();
    const usdc = caps.supportedAssets.find((a) => a.symbol === "USDC");
    // USDC is the payment rail (6dp, within the 18dp conformance ceiling).
    expect(usdc?.decimals).toBe(6);
    // Native NEAR uses 24 decimals (yoctoNEAR) — surfaced as a capability
    // feature rather than a supportedAsset, since 24 > the 18dp contract cap.
    expect(caps.features?.["nativeNear"]).toBe(true);
    expect(caps.features?.["nativeNearDecimals"]).toBe(24);
  });

  it("settles on chain and is non-EVM", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["nonEvm"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("binds the signer implicit account as publicHandle", async () => {
    const signer = new RealNearSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle).toBe(signer.accountId);
    expect(inst.publicHandle).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent per userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "u2" as UserId });
    const b = await c.createInstrument({ userId: "u2" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("rejects empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("getBalance()", () => {
  it("returns a USDC balance for a known instrument", async () => {
    const signer = new DemoNearSigner({
      accountId: "f".repeat(64),
      initialBalanceAtomic: "5000000",
    });
    const c = new NearConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });
    const inst = await c.createInstrument({ userId: "u3" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("5000000");
    expect(bal.money.currency).toBe("USDC");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-near-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable Ed25519 signature", async () => {
    const signer = new RealNearSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const userId = "u4" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signer).toBe(signer.accountId);

    // Reconstruct the canonical descriptor and verify the signature.
    const descriptor = canonicalTransferDescriptor({
      from: signer.accountId,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      reference: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("a tampered message fails verification", async () => {
    const signer = new RealNearSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const userId = "u5" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.accountId,
      to: "attacker.testnet", // tampered recipient
      amountAtomic: req.amount.amountAtomic,
      reference: req.nonce,
    });
    expect(signer.verify(signed.signature, tampered)).toBe(false);
  });

  it("rejects a mismatched protocol", async () => {
    const c = makeConnector();
    const userId = "u6" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-v9" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/near-pay-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    const userId = "u7" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-near-ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("echoes the request and attaches publicKey in extra", async () => {
    const signer = new RealNearSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const userId = "u8" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    expect((signed.extra as Record<string, unknown>)["publicKey"]).toBe(
      signer.publicKey
    );
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("settle()", () => {
  it("returns success with an ISO settledAt and transactionRef", async () => {
    const c = makeConnector();
    const userId = "u9" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("near-testnet");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof result.transactionRef).toBe("string");
  });

  it("fails with signature_invalid when signature is empty", async () => {
    const c = makeConnector();
    const userId = "u10" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const broken = { ...signed, signature: "" };
    const result = await c.settle(broken);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});

// ---------------------------------------------------------------------------
//  Named account + submit hook
// ---------------------------------------------------------------------------

describe("named account + submit hook", () => {
  it("supports a named .testnet account override", () => {
    const signer = new RealNearSigner({
      seed: TEST_SEED,
      accountId: "alice.testnet",
    });
    expect(signer.accountId).toBe("alice.testnet");
  });

  it("invokes the pluggable submit hook when provided", async () => {
    let called = false;
    const signer = new RealNearSigner({
      seed: TEST_SEED,
      submit: async () => {
        called = true;
        return { blockHash: "BLK123", explorerUrl: "https://x/tx" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: "merchant.testnet",
      amountAtomic: "1000000",
      reference: "n1",
    });
    expect(called).toBe(true);
    expect(res.blockHash).toBe("BLK123");
  });
});
