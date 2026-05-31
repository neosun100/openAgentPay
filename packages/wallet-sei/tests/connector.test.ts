/**
 * Sei connector + signer unit tests.
 *
 * Covers: keygen (24-word mnemonic + sei1… bech32 address shape + determinism),
 * capabilities, createInstrument (idempotency + empty-userId rejection),
 * getBalance (+ error), signAuthorization (real secp256k1 sig + protocol/
 * instrument errors + USDC denom routing), settle, signature verification +
 * tamper-rejection, and canonical descriptor determinism.
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
  SeiConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealSeiSigner,
  generateSeiWallet,
  generateSeiKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  canonicalTransferDescriptor,
  SEI_HD_PATH,
  SEI_COIN_TYPE,
  SEI_BECH32_PREFIX,
} from "../src/index.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function makeConnector() {
  return new SeiConnector({
    signer: new RealSeiSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "atlantic-2",
    }),
    instrumentStore: new MemoryInstrumentStore(),
    chainId: "atlantic-2",
  });
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "SEI" },
    spent: { amountAtomic: "0", decimals: 6, currency: "SEI" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "SEI" },
    recipient: "sei15f7sdzduxh5umchk433z275xz8gnw8lq9qsqvu",
    asset: { symbol: "SEI", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_TEST",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Keygen
// ---------------------------------------------------------------------------

describe("generateSeiWallet()", () => {
  it("produces a 24-word mnemonic and a sei1… address", () => {
    const w = generateSeiWallet();
    expect(w.mnemonic.split(" ").length).toBe(24);
    expect(w.address.startsWith("sei1")).toBe(true);
    // bech32 sei addresses are 42 chars: "sei1" (4) + 38 data/checksum.
    expect(w.address.length).toBe(42);
  });

  it("uses the standard Cosmos coin type 118 + m/44'/118'/0'/0/0 path", () => {
    expect(SEI_COIN_TYPE).toBe(118);
    expect(SEI_HD_PATH).toBe("m/44'/118'/0'/0/0");
    expect(SEI_BECH32_PREFIX).toBe("sei");
  });

  it("derives a deterministic sei1… address from a known mnemonic", () => {
    const a = keypairFromMnemonic(TEST_MNEMONIC);
    const b = keypairFromMnemonic(TEST_MNEMONIC);
    expect(a.address).toBe(b.address);
    expect(a.address.startsWith("sei1")).toBe(true);
    expect(a.publicKeyHex.length).toBe(66); // 33 bytes compressed
    expect(a.privateKeyHex.length).toBe(64); // 32 bytes
  });

  it("address = bech32(ripemd160(sha256(pubkey))) is reproducible from pubkey", () => {
    const kp = generateSeiKeypair();
    const pub = Uint8Array.from(
      kp.publicKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
    );
    expect(addressFromPublicKey(pub)).toBe(kp.address);
  });

  it("rejects an invalid mnemonic", () => {
    expect(() => keypairFromMnemonic("not a valid mnemonic phrase")).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  Capabilities
// ---------------------------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports the sei provider + sei-pay-v1 protocol + SEI/USDC", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe("sei");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.map((a) => a.symbol).sort()).toEqual([
      "SEI",
      "USDC",
    ]);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["bech32Prefix"]).toBe("sei");
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("creates an instrument whose publicHandle is the sei1… address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle.startsWith("sei1")).toBe(true);
    expect(inst.walletProvider).toBe("sei");
  });

  it("is idempotent per userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "same" as UserId });
    const b = await c.createInstrument({ userId: "same" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("rejects empty userId", async () => {
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
  it("returns a 0 SEI balance offline (no balanceReader)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("SEI");
    expect(BigInt(bal.money.amountAtomic) >= 0n).toBe(true);
  });

  it("uses an injected balanceReader when present", async () => {
    const c = new SeiConnector({
      signer: new RealSeiSigner({
        mnemonic: TEST_MNEMONIC,
        balanceReader: async () => 67890n,
      }),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "bal2" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("67890");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-sei-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable secp256k1 signature (tamper fails)", async () => {
    const signer = new RealSeiSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "atlantic-2",
    });
    const c = new SeiConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "atlantic-2",
    });
    const userId = "signer" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect(signed.signature.length).toBe(128); // 64-byte r||s hex
    expect(signed.signer).toBe(signer.address);
    // The signature verifies against the canonical descriptor.
    const descriptor = c.descriptorFor(signed);
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
    // Tampering breaks verification.
    expect(signer.verify(signed.signature, descriptor + "X")).toBe(false);
  });

  it("routes USDC to the uusdc denom", async () => {
    const c = makeConnector();
    const userId = "usdc-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest({
        asset: { symbol: "USDC", decimals: 6 },
        amount: { amountAtomic: "5000", decimals: 6, currency: "USDC" },
      }),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["denom"]).toBe("uusdc");
  });

  it("rejects a mismatched protocol", async () => {
    const c = makeConnector();
    const userId = "bad-proto" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "evm-x402-v1" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/sei-pay-v1/);
  });

  it("rejects an unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-sei-ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession("ghost" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("settle()", () => {
  it("returns success with the signature as transactionRef offline", async () => {
    const c = makeConnector();
    const userId = "settler" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.success).toBe(true);
    expect(res.network).toBe("sei-atlantic-2");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.transactionRef).toBe(signed.signature);
  });

  it("uses the broadcast txHash as transactionRef when a submit hook ran", async () => {
    const signer = new RealSeiSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "atlantic-2",
      submit: async () => ({ txHash: "ABCDEF123456", height: 42 }),
    });
    const c = new SeiConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "atlantic-2",
    });
    const userId = "bcast" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.transactionRef).toBe("ABCDEF123456");
  });

  it("fails with signature_invalid when signature is empty", async () => {
    const c = makeConnector();
    const res = await c.settle({
      request: buildRequest(),
      signer: "sei1xyz",
      signature: "",
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });
});

// ---------------------------------------------------------------------------
//  canonical descriptor
// ---------------------------------------------------------------------------

describe("canonicalTransferDescriptor()", () => {
  it("is deterministic for identical input", () => {
    const f = {
      from: "sei1a",
      to: "sei1b",
      amountAtomic: "1000",
      denom: "usei",
      chainId: "atlantic-2",
    };
    expect(canonicalTransferDescriptor(f)).toBe(canonicalTransferDescriptor(f));
    expect(canonicalTransferDescriptor(f)).toContain("sei-pay/v1");
  });
});
