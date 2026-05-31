/**
 * Initia connector + signer unit tests.
 *
 * Covers: keygen (mnemonic word count + bech32 "init1…" address shape),
 * capabilities, createInstrument (idempotency + empty-userId rejection),
 * getBalance (+ error), signAuthorization (real secp256k1 sig + protocol/
 * instrument errors), settle, and signature verification (incl. tampered-fails).
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type {
  PaymentRequest,
  ProtocolId,
  Session,
  SessionId,
  UserId,
  InstrumentId,
} from "@openagentpay/core";
import {
  InitiaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealInitiaSigner,
  generateInitiaWallet,
  generateInitiaKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  canonicalTransferDescriptor,
  INITIA_HD_PATH,
} from "../src/index.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

/** Verified vector for the all-"abandon…art" mnemonic at m/44'/118'/0'/0/0 + "init" hrp. */
const TEST_ADDRESS = "init1r5v5srda7xfth3hn2s26txvrcrntldju4a8gua";

function makeConnector() {
  return new InitiaConnector({
    signer: new RealInitiaSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "initiation-2",
    }),
    instrumentStore: new MemoryInstrumentStore(),
    chainId: "initiation-2",
  });
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "INIT" },
    spent: { amountAtomic: "0", decimals: 6, currency: "INIT" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "INIT" },
    recipient: "init1qy352eufqy352eufqy352eufqy35qqqz9w3z9w",
    asset: { symbol: "INIT", decimals: 6 },
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

describe("generateInitiaWallet()", () => {
  it("produces a 24-word mnemonic and an init1… address", () => {
    const w = generateInitiaWallet();
    expect(w.mnemonic.split(" ").length).toBe(24);
    expect(w.address.startsWith("init1")).toBe(true);
    // bech32 init addresses are 43 chars: "init1" (5) + 38 data/checksum.
    expect(w.address.length).toBe(43);
  });

  it("derives a deterministic address from a known mnemonic (m/44'/118'/0'/0/0)", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    expect(kp.address).toBe(TEST_ADDRESS);
    expect(kp.publicKeyHex.length).toBe(66); // 33 bytes compressed
    expect(kp.privateKeyHex.length).toBe(64); // 32 bytes
    expect(INITIA_HD_PATH).toBe("m/44'/118'/0'/0/0");
  });

  it("address = bech32(ripemd160(sha256(pubkey))) is reproducible from pubkey", () => {
    const kp = generateInitiaKeypair();
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
  it("reports the initia provider + initia-pay-v1 protocol + INIT/USDC", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe("initia");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.map((a) => a.symbol).sort()).toEqual([
      "INIT",
      "USDC",
    ]);
    expect(caps.settlesOnChain).toBe(true);
    expect((caps.features as Record<string, unknown>)["bech32Prefix"]).toBe(
      "init"
    );
  });

  it("keeps all asset decimals <= 24 (atomic-units invariant)", () => {
    const caps = makeConnector().getCapabilities();
    for (const a of caps.supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("creates an instrument whose publicHandle is the bech32 init1… address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle.startsWith("init1")).toBe(true);
    expect(inst.publicHandle).toBe(TEST_ADDRESS);
    expect(inst.walletProvider).toBe("initia");
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
  it("returns a 0 INIT balance offline (no balanceReader)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("INIT");
    expect(BigInt(bal.money.amountAtomic) >= 0n).toBe(true);
  });

  it("uses an injected balanceReader when present", async () => {
    const c = new InitiaConnector({
      signer: new RealInitiaSigner({
        mnemonic: TEST_MNEMONIC,
        balanceReader: async () => 12345n,
      }),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "bal2" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("12345");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-initia-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable secp256k1 signature", async () => {
    const signer = new RealInitiaSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "initiation-2",
    });
    const c = new InitiaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "initiation-2",
    });
    const userId = "signer" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
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

  it("routes INIT to the uinit denom", async () => {
    const c = makeConnector();
    const userId = "init-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["denom"]).toBe("uinit");
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
    ).rejects.toThrow(/initia-pay-v1/);
  });

  it("rejects an unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-initia-ghost" as InstrumentId,
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
    expect(res.network).toBe("initia-initiation-2");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.transactionRef).toBe(signed.signature);
  });

  it("uses the broadcast txHash as transactionRef when a submit hook ran", async () => {
    const signer = new RealInitiaSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "initiation-2",
      submit: async () => ({ txHash: "ABCDEF123456", height: 42 }),
    });
    const c = new InitiaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "initiation-2",
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
      signer: "init1xyz",
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
      from: "init1a",
      to: "init1b",
      amountAtomic: "1000",
      denom: "uinit",
      chainId: "initiation-2",
    };
    expect(canonicalTransferDescriptor(f)).toBe(canonicalTransferDescriptor(f));
    expect(canonicalTransferDescriptor(f)).toContain("initia-pay/v1");
  });
});
