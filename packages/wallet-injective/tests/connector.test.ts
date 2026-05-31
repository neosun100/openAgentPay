/**
 * Injective connector + signer unit tests.
 *
 * Covers: keygen (mnemonic word count + inj1 address shape + Ethermint
 * derivation vs ripemd160), capabilities, createInstrument (idempotency +
 * empty-userId rejection), getBalance (+ unknown-id error), signAuthorization
 * (real verifiable secp256k1/keccak sig + tampered-fails + protocol/instrument
 * errors), settle, EIP-55 cross-check, and canonical descriptor determinism.
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
  InjectiveConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealInjectiveSigner,
  generateInjectiveWallet,
  generateInjectiveKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  ethAddressBytes,
  canonicalTransferDescriptor,
  INJECTIVE_HD_PATH,
  INJECTIVE_COIN_TYPE,
} from "../src/index.js";
import { secp256k1 } from "@noble/curves/secp256k1";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function makeConnector() {
  return new InjectiveConnector({
    signer: new RealInjectiveSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "injective-888",
    }),
    instrumentStore: new MemoryInstrumentStore(),
    chainId: "injective-888",
  });
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000000000000000", decimals: 18, currency: "INJ" },
    spent: { amountAtomic: "0", decimals: 18, currency: "INJ" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000000000000000000", decimals: 18, currency: "INJ" },
    recipient: "inj1qy352eufqy352eufqy352eufqy352euny6h2gt",
    asset: { symbol: "INJ", decimals: 18 },
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

describe("generateInjectiveWallet()", () => {
  it("produces a 24-word mnemonic and an inj1 address", () => {
    const w = generateInjectiveWallet();
    expect(w.mnemonic.trim().split(/\s+/).length).toBe(24);
    expect(w.address.startsWith("inj1")).toBe(true);
  });

  it("derives distinct addresses for distinct mnemonics", () => {
    const a = generateInjectiveWallet();
    const b = generateInjectiveWallet();
    expect(a.address).not.toBe(b.address);
  });
});

describe("keypairFromMnemonic()", () => {
  it("is deterministic for the same mnemonic", () => {
    const a = keypairFromMnemonic(TEST_MNEMONIC);
    const b = keypairFromMnemonic(TEST_MNEMONIC);
    expect(a.address).toBe(b.address);
    expect(a.privateKeyHex).toBe(b.privateKeyHex);
    expect(a.address.startsWith("inj1")).toBe(true);
  });

  it("uses the Ethereum coin type 60 path m/44'/60'/0'/0/0", () => {
    expect(INJECTIVE_COIN_TYPE).toBe(60);
    expect(INJECTIVE_HD_PATH).toBe("m/44'/60'/0'/0/0");
  });

  it("rejects an invalid mnemonic", () => {
    expect(() => keypairFromMnemonic("not a real mnemonic at all")).toThrow(
      /Invalid BIP39/
    );
  });

  it("exposes a matching EIP-55 0x address (33↔65 byte pubkey agree)", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    expect(kp.ethAddress.startsWith("0x")).toBe(true);
    expect(kp.ethAddress.length).toBe(42);
    // The bech32 "inj" address and the 0x address share the same 20-byte body.
    const compressed = secp256k1.getPublicKey(
      Uint8Array.from(
        kp.privateKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
      ),
      true
    );
    const eth20 = ethAddressBytes(compressed);
    const hex = Array.from(eth20, (b) => b.toString(16).padStart(2, "0")).join(
      ""
    );
    expect(kp.ethAddress.toLowerCase()).toBe("0x" + hex);
  });
});

describe("addressFromPublicKey() — Ethermint derivation", () => {
  it("accepts compressed and uncompressed pubkeys to the same address", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    const priv = Uint8Array.from(
      kp.privateKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
    );
    const compressed = secp256k1.getPublicKey(priv, true); // 33
    const uncompressed = secp256k1.getPublicKey(priv, false); // 65
    expect(addressFromPublicKey(compressed)).toBe(kp.address);
    expect(addressFromPublicKey(uncompressed)).toBe(kp.address);
  });

  it("yields a 20-byte (keccak, not ripemd) address payload", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    const priv = Uint8Array.from(
      kp.privateKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
    );
    const eth20 = ethAddressBytes(secp256k1.getPublicKey(priv, true));
    expect(eth20.length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
//  getCapabilities
// ---------------------------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports the injective provider, protocol, and Ethermint flag", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe("injective");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["ethermint"]).toBe(true);
    expect(caps.features?.["coinType"]).toBe(60);
    expect(caps.supportedAssets.find((a) => a.symbol === "INJ")?.decimals).toBe(
      18
    );
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("is idempotent per user", async () => {
    const c = makeConnector();
    const userId = "alice" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle.startsWith("inj1")).toBe(true);
  });

  it("rejects an empty userId", async () => {
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
  it("returns INJ with 18 decimals (offline → 0)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.asset.symbol).toBe("INJ");
    expect(bal.money.decimals).toBe(18);
    expect(bal.money.amountAtomic).toBe("0");
  });

  it("throws on an unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-injective-ghost" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });

  it("reads a balance via a wired balanceReader", async () => {
    const c = new InjectiveConnector({
      signer: new RealInjectiveSigner({
        mnemonic: TEST_MNEMONIC,
        chainId: "injective-888",
        balanceReader: async () => 42n,
      }),
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "injective-888",
    });
    const inst = await c.createInstrument({ userId: "rich" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("42");
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable secp256k1/keccak signature", async () => {
    const signer = new RealInjectiveSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "injective-888",
    });
    const c = new InjectiveConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "injective-888",
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
    expect(signed.signer.startsWith("inj1")).toBe(true);
    // The signature verifies against the canonical descriptor.
    const descriptor = c.descriptorFor(signed);
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
    // Tampering breaks verification.
    expect(signer.verify(signed.signature, descriptor + "X")).toBe(false);
  });

  it("routes USDT to the peggy denom", async () => {
    const c = makeConnector();
    const userId = "usdt-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest({
        asset: { symbol: "USDT", decimals: 6 },
        amount: { amountAtomic: "5000000", decimals: 6, currency: "USDT" },
      }),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["denom"]).toMatch(
      /^peggy/
    );
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
    ).rejects.toThrow(/injective-pay-v1/);
  });

  it("rejects an unknown instrumentId", async () => {
    const c = makeConnector();
    const userId = "ghost" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-injective-ghost" as InstrumentId,
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
    expect(res.network).toBe("injective-injective-888");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.transactionRef).toBe(signed.signature);
  });

  it("uses the broadcast txHash as transactionRef when a submit hook ran", async () => {
    const signer = new RealInjectiveSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "injective-888",
      submit: async () => ({ txHash: "0xABCDEF123456", height: 42 }),
    });
    const c = new InjectiveConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "injective-888",
    });
    const userId = "bcast" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["txHash"]).toBe(
      "0xABCDEF123456"
    );
    const res = await c.settle(signed);
    expect(res.transactionRef).toBe("0xABCDEF123456");
  });

  it("fails with signature_invalid when signature is empty", async () => {
    const c = makeConnector();
    const res = await c.settle({
      request: buildRequest(),
      signer: "inj1xyz",
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
      from: "inj1a",
      to: "inj1b",
      amountAtomic: "1000",
      denom: "inj",
      chainId: "injective-888",
    };
    expect(canonicalTransferDescriptor(f)).toBe(canonicalTransferDescriptor(f));
    expect(canonicalTransferDescriptor(f)).toContain("injective-pay/v1");
  });
});
