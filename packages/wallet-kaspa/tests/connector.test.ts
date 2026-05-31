/**
 * Kaspa connector + signer unit tests.
 *
 * Covers: keygen (mnemonic word count + kaspatest: address shape + determinism),
 * address round-trip decode, capabilities, createInstrument (idempotency +
 * empty-userId rejection), getBalance (+ injected reader + error),
 * signAuthorization (real secp256k1 sig + verify + tamper-fails + protocol/
 * instrument errors), settle (offline + broadcast + empty-sig), and the
 * canonical descriptor determinism.
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
  KaspaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  KAS_DECIMALS,
  RealKaspaSigner,
  generateKaspaWallet,
  generateKaspaKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  decodeAddress,
  canonicalTransferDescriptor,
  KASPA_HD_PATH,
  KASPA_HRP,
} from "../src/index.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function makeConnector() {
  return new KaspaConnector({
    signer: new RealKaspaSigner({
      mnemonic: TEST_MNEMONIC,
      network: "testnet-10",
    }),
    instrumentStore: new MemoryInstrumentStore(),
    network: "testnet-10",
  });
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: KAS_DECIMALS, currency: "KAS" },
    spent: { amountAtomic: "0", decimals: KAS_DECIMALS, currency: "KAS" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "100000000", decimals: KAS_DECIMALS, currency: "KAS" },
    recipient: "kaspatest:qqrecipientplaceholder000000000000000000000",
    asset: { symbol: "KAS", decimals: KAS_DECIMALS },
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

describe("generateKaspaWallet()", () => {
  it("produces a 24-word mnemonic and a kaspatest: address", () => {
    const w = generateKaspaWallet();
    expect(w.mnemonic.split(" ").length).toBe(24);
    expect(w.address.startsWith("kaspatest:")).toBe(true);
  });

  it("derives a deterministic address+key from a known mnemonic (m/44'/111111'/0'/0/0)", () => {
    const a = keypairFromMnemonic(TEST_MNEMONIC);
    const b = keypairFromMnemonic(TEST_MNEMONIC);
    // Determinism: same mnemonic → same key + address.
    expect(a.address).toBe(b.address);
    expect(a.privateKeyHex).toBe(b.privateKeyHex);
    expect(a.address.startsWith("kaspatest:")).toBe(true);
    expect(a.publicKeyHex.length).toBe(66); // 33 bytes compressed
    expect(a.privateKeyHex.length).toBe(64); // 32 bytes
    expect(KASPA_HD_PATH).toBe("m/44'/111111'/0'/0/0");
  });

  it("address = cashaddr(version || x-pubkey) is reproducible from pubkey", () => {
    const kp = generateKaspaKeypair();
    const pub = Uint8Array.from(
      kp.publicKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
    );
    expect(addressFromPublicKey(pub)).toBe(kp.address);
  });

  it("rejects an invalid mnemonic", () => {
    expect(() => keypairFromMnemonic("not a valid mnemonic phrase")).toThrow();
  });

  it("two fresh wallets get distinct addresses", () => {
    const a = generateKaspaWallet();
    const b = generateKaspaWallet();
    expect(a.address).not.toBe(b.address);
  });
});

// ---------------------------------------------------------------------------
//  Address round-trip
// ---------------------------------------------------------------------------

describe("decodeAddress()", () => {
  it("round-trips the x-only pubkey payload from a generated address", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    const decoded = decodeAddress(kp.address);
    expect(decoded.hrp).toBe(KASPA_HRP);
    expect(decoded.version).toBe(0x00);
    expect(decoded.xOnlyPubkey.length).toBe(32);
    // The decoded x-only pubkey matches the compressed pubkey's x coordinate.
    const expectedX = kp.publicKeyHex.slice(2); // drop 02/03 prefix
    const gotX = Array.from(decoded.xOnlyPubkey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(gotX).toBe(expectedX);
  });

  it("throws on a malformed address", () => {
    expect(() => decodeAddress("kaspatest:!!!notvalid!!!")).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  Capabilities
// ---------------------------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports the kaspa provider + kaspa-pay-v1 protocol + KAS (8 dp)", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe("kaspa");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.map((a) => a.symbol)).toEqual(["KAS"]);
    expect(caps.supportedAssets[0]!.decimals).toBe(8);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["cashaddrHrp"]).toBe("kaspatest");
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("creates an instrument whose publicHandle is the kaspatest: address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle.startsWith("kaspatest:")).toBe(true);
    expect(inst.walletProvider).toBe("kaspa");
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
  it("returns a 0 KAS balance offline (no balanceReader)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("KAS");
    expect(bal.money.decimals).toBe(8);
    expect(BigInt(bal.money.amountAtomic) >= 0n).toBe(true);
  });

  it("uses an injected balanceReader when present", async () => {
    const c = new KaspaConnector({
      signer: new RealKaspaSigner({
        mnemonic: TEST_MNEMONIC,
        balanceReader: async () => 4200000000n, // 42 KAS in sompi
      }),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "bal2" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("4200000000");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-kaspa-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable secp256k1 signature", async () => {
    const signer = new RealKaspaSigner({
      mnemonic: TEST_MNEMONIC,
      network: "testnet-10",
    });
    const c = new KaspaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet-10",
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

  it("emits sompi denom + pubkey in extra", async () => {
    const c = makeConnector();
    const userId = "extra-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const extra = signed.extra as Record<string, unknown>;
    expect(extra["denom"]).toBe("sompi");
    expect(typeof extra["pubkeyHex"]).toBe("string");
    expect(extra["network"]).toBe("testnet-10");
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
    ).rejects.toThrow(/kaspa-pay-v1/);
  });

  it("rejects an unknown instrumentId", async () => {
    const c = makeConnector();
    const userId = "ghost" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-kaspa-ghost" as InstrumentId,
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
    expect(res.network).toBe("kaspa-testnet-10");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.transactionRef).toBe(signed.signature);
  });

  it("uses the broadcast txId as transactionRef when a submit hook ran", async () => {
    const signer = new RealKaspaSigner({
      mnemonic: TEST_MNEMONIC,
      network: "testnet-10",
      submit: async () => ({ txId: "kaspatx00abcdef", daaScore: 99 }),
    });
    const c = new KaspaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet-10",
    });
    const userId = "bcast" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.transactionRef).toBe("kaspatx00abcdef");
    expect((res.raw as Record<string, unknown>)["daaScore"]).toBe(99);
  });

  it("fails with signature_invalid when signature is empty", async () => {
    const c = makeConnector();
    const res = await c.settle({
      request: buildRequest(),
      signer: "kaspatest:qqxyz",
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
  it("is deterministic for identical input and tags kaspa-pay/v1 + sompi", () => {
    const f = {
      from: "kaspatest:qqa",
      to: "kaspatest:qqb",
      amountAtomic: "100000000",
      network: "testnet-10",
    };
    expect(canonicalTransferDescriptor(f)).toBe(canonicalTransferDescriptor(f));
    expect(canonicalTransferDescriptor(f)).toContain("kaspa-pay/v1");
    expect(canonicalTransferDescriptor(f)).toContain("denom=sompi");
  });
});
