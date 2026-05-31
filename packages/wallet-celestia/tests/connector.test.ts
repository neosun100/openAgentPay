/**
 * Celestia connector + signer unit tests.
 *
 * Covers: keygen (mnemonic word count + bech32 address shape), capabilities,
 * createInstrument (idempotency + empty-userId rejection), getBalance (+ error),
 * signAuthorization (real secp256k1 sig + protocol/instrument errors),
 * settle, and signature verification (incl. tampered-fails).
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
  CelestiaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealCelestiaSigner,
  generateCelestiaWallet,
  generateCelestiaKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  canonicalTransferDescriptor,
  CELESTIA_HD_PATH,
  CELESTIA_BECH32_PREFIX,
  TIA_DENOM,
} from "../src/index.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function makeConnector() {
  return new CelestiaConnector({
    signer: new RealCelestiaSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "mocha-4",
    }),
    instrumentStore: new MemoryInstrumentStore(),
    chainId: "mocha-4",
  });
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "TIA" },
    spent: { amountAtomic: "0", decimals: 6, currency: "TIA" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "TIA" },
    recipient: "celestia1qv9pzxqlyckngw6zf9g9whn9d3eh4qvgqag6fl",
    asset: { symbol: "TIA", decimals: 6 },
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

describe("generateCelestiaWallet()", () => {
  it("produces a 24-word mnemonic and a celestia1… address", () => {
    const w = generateCelestiaWallet();
    expect(w.mnemonic.split(" ").length).toBe(24);
    expect(w.address.startsWith("celestia1")).toBe(true);
    // bech32 celestia addresses are 47 chars: "celestia1" (9) + 38 data/checksum.
    expect(w.address.length).toBe(47);
  });

  it("derives a deterministic address from a known mnemonic (m/44'/118'/0'/0/0)", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    // Same key material as Cosmos Hub (coin type 118), re-encoded under the
    // "celestia" hrp. Verified vector for the all-"abandon…art" mnemonic.
    expect(kp.address).toBe("celestia1r5v5srda7xfth3hn2s26txvrcrntldju2pktdj");
    expect(kp.publicKeyHex.length).toBe(66); // 33 bytes compressed
    expect(kp.privateKeyHex.length).toBe(64); // 32 bytes
    expect(kp.prefix).toBe(CELESTIA_BECH32_PREFIX);
    expect(CELESTIA_HD_PATH).toBe("m/44'/118'/0'/0/0");
  });

  it("address = bech32(ripemd160(sha256(pubkey))) is reproducible from pubkey", () => {
    const kp = generateCelestiaKeypair();
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
  it("reports the celestia provider + celestia-pay-v1 protocol + TIA", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe("celestia");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.map((a) => a.symbol)).toEqual(["TIA"]);
    expect(caps.supportedAssets.every((a) => a.decimals <= 24)).toBe(true);
    expect(caps.settlesOnChain).toBe(true);
    expect((caps.features as Record<string, unknown>)["nonEvm"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("creates an instrument whose publicHandle is the bech32 address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle.startsWith("celestia1")).toBe(true);
    expect(inst.walletProvider).toBe("celestia");
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
  it("returns a 0 TIA balance offline (no balanceReader)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("TIA");
    expect(bal.money.decimals).toBe(6);
    expect(BigInt(bal.money.amountAtomic) >= 0n).toBe(true);
  });

  it("uses an injected balanceReader when present", async () => {
    const c = new CelestiaConnector({
      signer: new RealCelestiaSigner({
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
      c.getBalance("payment-instrument-celestia-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable secp256k1 signature (tampering fails)", async () => {
    const signer = new RealCelestiaSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "mocha-4",
    });
    const c = new CelestiaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "mocha-4",
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
    expect(signed.signer.startsWith("celestia1")).toBe(true);
    // The signature verifies against the canonical descriptor.
    const descriptor = c.descriptorFor(signed);
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
    // Tampering breaks verification.
    expect(signer.verify(signed.signature, descriptor + "X")).toBe(false);
  });

  it("routes TIA to the utia denom", async () => {
    const c = makeConnector();
    const userId = "tia-user" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["denom"]).toBe(TIA_DENOM);
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
    ).rejects.toThrow(/celestia-pay-v1/);
  });

  it("rejects an unknown instrumentId", async () => {
    const c = makeConnector();
    const userId = "ghost" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-celestia-ghost" as InstrumentId,
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
    expect(res.network).toBe("celestia-mocha-4");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.transactionRef).toBe(signed.signature);
  });

  it("uses the broadcast txHash as transactionRef when a submit hook ran", async () => {
    const signer = new RealCelestiaSigner({
      mnemonic: TEST_MNEMONIC,
      chainId: "mocha-4",
      submit: async () => ({ txHash: "ABCDEF123456", height: 42 }),
    });
    const c = new CelestiaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      chainId: "mocha-4",
    });
    const userId = "bcast" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["txHash"]).toBe(
      "ABCDEF123456"
    );
    const res = await c.settle(signed);
    expect(res.transactionRef).toBe("ABCDEF123456");
  });

  it("fails with signature_invalid when signature is empty", async () => {
    const c = makeConnector();
    const res = await c.settle({
      request: buildRequest(),
      signer: "celestia1xyz",
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
  it("is deterministic for identical input and tagged celestia-pay/v1", () => {
    const f = {
      from: "celestia1a",
      to: "celestia1b",
      amountAtomic: "1000",
      denom: "utia",
      chainId: "mocha-4",
    };
    expect(canonicalTransferDescriptor(f)).toBe(canonicalTransferDescriptor(f));
    expect(canonicalTransferDescriptor(f)).toContain("celestia-pay/v1");
  });
});
