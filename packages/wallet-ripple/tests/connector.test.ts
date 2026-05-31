/**
 * Unit tests for @openagentpay/wallet-ripple — connector behavior, XRPL
 * base58check keygen/codec correctness, real Ed25519 sign+verify, and error
 * paths.
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
  RippleConnector,
  MemoryInstrumentStore,
  DemoRippleSigner,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  RealRippleSigner,
  generateRippleKeypair,
  keypairFromSeed,
  keypairFromSeedHex,
  canonicalTransferDescriptor,
  base58Encode,
  base58Decode,
  base58CheckEncode,
  base58CheckDecode,
  encodeAddress,
  decodeAddress,
  accountIdFromPubkey,
  isValidAddress,
  decimalToDrops,
  XRPL_ALPHABET,
} from "../src/index.js";

const TEST_SEED = new Uint8Array(32).fill(7);

function makeConnector(
  signer = new RealRippleSigner({ seed: TEST_SEED, network: "testnet" })
) {
  return new RippleConnector({
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
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "XRP" },
    spent: { amountAtomic: "0", decimals: 6, currency: "XRP" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1500000", decimals: 6, currency: "XRP" },
    recipient: generateRippleKeypair().address,
    asset: { symbol: "XRP", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "TAG_1",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  XRPL base58check keygen + codec
// ---------------------------------------------------------------------------

describe("XRPL base58check keygen + codec", () => {
  it("generates a real 'r...' classic address", () => {
    const kp = generateRippleKeypair();
    expect(kp.address.startsWith("r")).toBe(true);
    expect(kp.address.length).toBeGreaterThanOrEqual(25);
    expect(kp.address.length).toBeLessThanOrEqual(35);
    expect(isValidAddress(kp.address)).toBe(true);
  });

  it("uses the CUSTOM Ripple alphabet (not Bitcoin base58)", () => {
    // Bitcoin alphabet starts "123..."; XRPL starts "rps...".
    expect(XRPL_ALPHABET.startsWith("rpsh")).toBe(true);
    // Every character of a generated address must be in the XRPL alphabet.
    const kp = generateRippleKeypair();
    for (const ch of kp.address) {
      expect(XRPL_ALPHABET.includes(ch)).toBe(true);
    }
  });

  it("exposes a prefixed ed25519 public key (0xED || raw32 → 33 bytes)", () => {
    const kp = keypairFromSeed(TEST_SEED);
    expect(kp.publicKeyHex.toUpperCase().startsWith("ED")).toBe(true);
    expect(kp.publicKeyHex.length).toBe(66); // 33 bytes hex
  });

  it("is deterministic from a fixed seed", () => {
    const a = keypairFromSeed(TEST_SEED);
    const b = keypairFromSeed(TEST_SEED);
    expect(a.address).toBe(b.address);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
  });

  it("round-trips seedHex → keypair → same address", () => {
    const a = keypairFromSeed(TEST_SEED);
    const b = keypairFromSeedHex(a.secretSeedHex);
    expect(b.address).toBe(a.address);
  });

  it("encodeAddress / decodeAddress round-trips the 20-byte accountId", () => {
    const kp = keypairFromSeed(TEST_SEED);
    const accountId = decodeAddress(kp.address);
    expect(accountId.length).toBe(20);
    expect(encodeAddress(accountId)).toBe(kp.address);
  });

  it("base58 encode/decode round-trips arbitrary bytes incl. leading zeros", () => {
    const data = new Uint8Array([0, 0, 1, 2, 3, 250, 251, 255]);
    const enc = base58Encode(data);
    const dec = base58Decode(enc);
    expect(Array.from(dec)).toEqual(Array.from(data));
  });

  it("base58check detects a tampered checksum", () => {
    const addr = generateRippleKeypair().address;
    // Flip the last character to a different valid-alphabet char.
    const last = addr[addr.length - 1]!;
    const repl = last === "r" ? "p" : "r";
    const tampered = addr.slice(0, -1) + repl;
    expect(() => base58CheckDecode(tampered)).toThrow();
    expect(isValidAddress(tampered)).toBe(false);
  });

  it("base58CheckEncode/decode preserves version + payload", () => {
    const payload = new Uint8Array(20).fill(9);
    const enc = base58CheckEncode(0x00, payload);
    const { version, payload: out } = base58CheckDecode(enc);
    expect(version).toBe(0x00);
    expect(Array.from(out)).toEqual(Array.from(payload));
  });

  it("accountIdFromPubkey produces a 20-byte ripemd160(sha256) digest", () => {
    const kp = keypairFromSeed(TEST_SEED);
    // raw 32-byte pubkey = drop the 0xED prefix
    const rawPub = Uint8Array.from(
      kp.publicKeyHex
        .slice(2)
        .match(/.{2}/g)!
        .map((h) => parseInt(h, 16))
    );
    const accountId = accountIdFromPubkey(rawPub);
    expect(accountId.length).toBe(20);
    expect(encodeAddress(accountId)).toBe(kp.address);
  });

  it("rejects an invalid base58 character on decode", () => {
    // '0' (zero) is NOT in the XRPL alphabet.
    expect(() => base58Decode("r0r0")).toThrow(/invalid character/);
  });
});

// ---------------------------------------------------------------------------
//  Real Ed25519 sign + verify
// ---------------------------------------------------------------------------

describe("RealRippleSigner sign + verify", () => {
  it("produces a verifiable signature over the canonical descriptor", async () => {
    const signer = new RealRippleSigner({ seed: TEST_SEED, network: "testnet" });
    const recipient = generateRippleKeypair().address;
    const res = await signer.signAndSubmit({
      recipient,
      amountAtomic: "1500000",
      destinationTag: "TAG_1",
    });
    const descriptor = canonicalTransferDescriptor({
      network: "testnet",
      from: signer.address,
      to: recipient,
      amountAtomic: "1500000",
      destinationTag: "TAG_1",
    });
    expect(signer.verify(res.signatureHex, descriptor)).toBe(true);
  });

  it("fails verification against a tampered message", async () => {
    const signer = new RealRippleSigner({ seed: TEST_SEED, network: "testnet" });
    const recipient = generateRippleKeypair().address;
    const res = await signer.signAndSubmit({
      recipient,
      amountAtomic: "1500000",
      destinationTag: "TAG_1",
    });
    const tampered = canonicalTransferDescriptor({
      network: "testnet",
      from: signer.address,
      to: recipient,
      amountAtomic: "9999999", // changed amount
      destinationTag: "TAG_1",
    });
    expect(signer.verify(res.signatureHex, tampered)).toBe(false);
  });

  it("returns uppercase-hex signature (XRPL convention)", async () => {
    const signer = new RealRippleSigner({ seed: TEST_SEED });
    const res = await signer.signAndSubmit({
      recipient: generateRippleKeypair().address,
      amountAtomic: "1000000",
    });
    expect(res.signatureHex).toBe(res.signatureHex.toUpperCase());
    expect(res.signatureHex.length).toBe(128); // 64-byte ed25519 sig hex
  });

  it("invokes the pluggable submit hook when provided", async () => {
    let called = false;
    const signer = new RealRippleSigner({
      seed: TEST_SEED,
      network: "testnet",
      submit: async (i) => {
        called = true;
        expect(i.signer).toMatch(/^r/);
        expect(i.signatureHex.length).toBe(128);
        return { hash: "DEADBEEF", ledgerIndex: 42 };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: generateRippleKeypair().address,
      amountAtomic: "1000000",
    });
    expect(called).toBe(true);
    expect(res.hash).toBe("DEADBEEF");
    expect(res.ledgerIndex).toBe(42);
  });
});

// ---------------------------------------------------------------------------
//  Connector behavior
// ---------------------------------------------------------------------------

describe("RippleConnector capabilities", () => {
  it("reports ripple provider + xrpl-pay-v1 protocol + XRP asset", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.settlesOnChain).toBe(true);
    const xrp = caps.supportedAssets.find((a) => a.symbol === "XRP");
    expect(xrp).toBeDefined();
    expect(xrp!.decimals).toBe(6);
  });
});

describe("RippleConnector createInstrument", () => {
  it("throws on empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow();
  });

  it("is idempotent for the same userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "alice" as UserId });
    const b = await c.createInstrument({ userId: "alice" as UserId });
    expect(b.id).toBe(a.id);
    expect(a.publicHandle.startsWith("r")).toBe(true);
  });

  it("binds the instrument publicHandle to the signer address", async () => {
    const signer = new RealRippleSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const inst = await c.createInstrument({ userId: "bob" as UserId });
    expect(inst.publicHandle).toBe(signer.address);
  });
});

describe("RippleConnector getBalance", () => {
  it("throws on an unknown instrument id", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });

  it("returns XRP money with 6 decimals", async () => {
    const signer = new DemoRippleSigner({ initialBalanceAtomic: "25000000" });
    const c = new RippleConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });
    const inst = await c.createInstrument({ userId: "carol" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.currency).toBe("XRP");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.amountAtomic).toBe("25000000");
  });
});

describe("RippleConnector signAuthorization", () => {
  it("rejects a wrong-protocol request", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "dave" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "x402-v1" as ProtocolId }),
        session: buildSession("dave" as UserId),
      })
    ).rejects.toThrow(/xrpl-pay-v1/);
  });

  it("rejects an unknown instrument id", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession("dave" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("produces a real, verifiable signature and binds the signer", async () => {
    const signer = new RealRippleSigner({ seed: TEST_SEED, network: "testnet" });
    const c = makeConnector(signer);
    const inst = await c.createInstrument({ userId: "erin" as UserId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession("erin" as UserId),
    });
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature.length).toBe(128);
    const descriptor = canonicalTransferDescriptor({
      network: "testnet",
      from: signer.address,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      destinationTag: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });
});

describe("RippleConnector settle", () => {
  it("returns a successful settlement with a transactionRef", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "frank" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("frank" as UserId),
    });
    const res = await c.settle(signed);
    expect(res.success).toBe(true);
    expect(res.transactionRef).toBeDefined();
    expect(res.network).toBe("ripple-testnet");
    expect(res.settledAmount?.currency).toBe("XRP");
  });

  it("fails settlement on a missing signature", async () => {
    const c = makeConnector();
    const res = await c.settle({
      request: buildRequest(),
      signer: "rXXX",
      signature: "",
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });
});

// ---------------------------------------------------------------------------
//  decimalToDrops helper
// ---------------------------------------------------------------------------

describe("decimalToDrops", () => {
  it("converts 1.5 XRP → 1500000 drops", () => {
    expect(decimalToDrops("1.5")).toBe("1500000");
  });
  it("converts 1 XRP → 1000000 drops", () => {
    expect(decimalToDrops("1")).toBe("1000000");
  });
  it("truncates beyond 6 decimals", () => {
    expect(decimalToDrops("0.0000001")).toBe("0");
  });
  it("throws on a non-numeric string", () => {
    expect(() => decimalToDrops("abc")).toThrow();
  });
});
