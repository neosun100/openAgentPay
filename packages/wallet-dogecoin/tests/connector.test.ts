/**
 * DogecoinConnector + RealDogecoinSigner unit tests.
 *
 * Covers: keypair generation, address format, base58check round-trips,
 * real sign→verify, tampered-message-fails, connector lifecycle, error paths.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type {
  PaymentRequest,
  Session,
  SessionId,
  UserId,
} from "@openagentpay/core";
import {
  DogecoinConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  RealDogecoinSigner,
  generateDogecoinKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  encodeP2PKHAddress,
  decodeP2PKHAddress,
  base58CheckEncode,
  base58CheckDecode,
  hash160,
  canonicalTransferDescriptor,
} from "../src/index.js";

const TEST_PRIV = new Uint8Array(32).fill(7);

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 8, currency: "DOGE" },
    spent: { amountAtomic: "0", decimals: 8, currency: "DOGE" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "100000000", decimals: 8, currency: "DOGE" },
    recipient: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
    asset: { symbol: "DOGE", decimals: 8 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

function makeConnector(network: "testnet" | "mainnet" = "testnet") {
  return new DogecoinConnector({
    signer: new RealDogecoinSigner({ privateKey: TEST_PRIV, network }),
    instrumentStore: new MemoryInstrumentStore(),
    network,
  });
}

describe("RealDogecoinSigner — keypair + address", () => {
  it("generates a testnet P2PKH address starting with n or m", () => {
    const kp = generateDogecoinKeypair("testnet");
    expect(kp.network).toBe("testnet");
    expect(/^[nm]/.test(kp.address)).toBe(true);
    expect(kp.publicKeyHex.length).toBe(66); // 33 bytes compressed
    expect(kp.hash160Hex.length).toBe(40); // 20 bytes
  });

  it("generates a mainnet P2PKH address starting with D", () => {
    const kp = generateDogecoinKeypair("mainnet");
    expect(kp.network).toBe("mainnet");
    expect(kp.address.startsWith("D")).toBe(true);
  });

  it("derives a deterministic address from a fixed private key", () => {
    const a = keypairFromPrivateKey(TEST_PRIV, "testnet");
    const b = keypairFromPrivateKey(TEST_PRIV, "testnet");
    expect(a.address).toBe(b.address);
    expect(a.privateKeyHex).toBe(b.privateKeyHex);
  });

  it("keypairFromHex round-trips with keypairFromPrivateKey", () => {
    const kp = keypairFromPrivateKey(TEST_PRIV, "testnet");
    const fromHex = keypairFromHex(kp.privateKeyHex, "testnet");
    expect(fromHex.address).toBe(kp.address);
  });

  it("rejects a private key of the wrong length", () => {
    expect(() => keypairFromPrivateKey(new Uint8Array(31), "testnet")).toThrow();
  });
});

describe("base58check + P2PKH address codec", () => {
  it("base58check encode→decode round-trips a payload", () => {
    const payload = new Uint8Array([0x71, ...new Array(20).fill(0xab)]);
    const enc = base58CheckEncode(payload);
    const dec = base58CheckDecode(enc);
    expect(Array.from(dec)).toEqual(Array.from(payload));
  });

  it("base58check decode throws on a corrupted checksum", () => {
    const payload = new Uint8Array([0x71, ...new Array(20).fill(0x01)]);
    const enc = base58CheckEncode(payload);
    // flip the last char to break the checksum
    const corrupted = enc.slice(0, -1) + (enc.endsWith("A") ? "B" : "A");
    expect(() => base58CheckDecode(corrupted)).toThrow();
  });

  it("encodeP2PKHAddress→decodeP2PKHAddress round-trips the hash160", () => {
    const program = hash160(new TextEncoder().encode("doge-much-wow"));
    const addr = encodeP2PKHAddress(program, "testnet");
    const back = decodeP2PKHAddress(addr, "testnet");
    expect(Array.from(back)).toEqual(Array.from(program));
  });

  it("decodeP2PKHAddress rejects a mainnet address on the testnet network", () => {
    const program = hash160(new TextEncoder().encode("x"));
    const mainnetAddr = encodeP2PKHAddress(program, "mainnet");
    expect(() => decodeP2PKHAddress(mainnetAddr, "testnet")).toThrow();
  });

  it("encodeP2PKHAddress rejects a non-20-byte hash", () => {
    expect(() => encodeP2PKHAddress(new Uint8Array(19), "testnet")).toThrow();
  });
});

describe("RealDogecoinSigner — sign + verify", () => {
  it("produces a REAL signature that verifies against the descriptor", async () => {
    const signer = new RealDogecoinSigner({
      privateKey: TEST_PRIV,
      network: "testnet",
    });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
      amountKoinu: "100000000",
      reference: "REF1",
    });
    const res = await signer.signAndSubmit({
      recipient: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
      amountKoinu: "100000000",
      reference: "REF1",
    });
    expect(res.signature.length).toBeGreaterThan(0);
    expect(signer.verify(res.signature, descriptor)).toBe(true);
  });

  it("verify FAILS on a tampered descriptor (amount changed)", async () => {
    const signer = new RealDogecoinSigner({
      privateKey: TEST_PRIV,
      network: "testnet",
    });
    const res = await signer.signAndSubmit({
      recipient: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
      amountKoinu: "100000000",
      reference: "REF1",
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.address,
      to: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
      amountKoinu: "999999999", // changed
      reference: "REF1",
    });
    expect(signer.verify(res.signature, tampered)).toBe(false);
  });

  it("verify returns false for a garbage signature", () => {
    const signer = new RealDogecoinSigner({ privateKey: TEST_PRIV });
    expect(signer.verify("deadbeef", "anything")).toBe(false);
  });

  it("getBalance returns 0n offline (no balanceReader)", async () => {
    const signer = new RealDogecoinSigner({ privateKey: TEST_PRIV });
    expect(await signer.getBalance()).toBe(0n);
  });

  it("uses the pluggable submit hook when provided", async () => {
    let called = false;
    const signer = new RealDogecoinSigner({
      privateKey: TEST_PRIV,
      submit: async () => {
        called = true;
        return { txid: "BROADCAST_TXID", explorerUrl: "https://x/tx/BROADCAST_TXID" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
      amountKoinu: "100000000",
    });
    expect(called).toBe(true);
    expect(res.txid).toBe("BROADCAST_TXID");
  });
});

describe("DogecoinConnector — capabilities + lifecycle", () => {
  it("reports the dogecoin provider + DOGE asset (8 dp) + protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedAssets[0]?.symbol).toBe("DOGE");
    expect(caps.supportedAssets[0]?.decimals).toBe(8);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.features?.["segwit"]).toBe(false);
  });

  it("createInstrument rejects an empty userId", async () => {
    await expect(
      makeConnector().createInstrument({ userId: "" as UserId })
    ).rejects.toThrow();
  });

  it("createInstrument is idempotent for the same userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "u1" as UserId });
    const b = await c.createInstrument({ userId: "u1" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("instrument publicHandle matches the signer address", async () => {
    const signer = new RealDogecoinSigner({ privateKey: TEST_PRIV, network: "testnet" });
    const c = new DogecoinConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });
    const inst = await c.createInstrument({ userId: "u2" as UserId });
    expect(inst.publicHandle).toBe(signer.address);
  });

  it("getBalance throws for an unknown instrument id", async () => {
    await expect(
      makeConnector().getBalance("nope" as never)
    ).rejects.toThrow();
  });
});

describe("DogecoinConnector — signAuthorization + settle", () => {
  it("signs a valid request and the signature verifies", async () => {
    const c = makeConnector();
    const userId = "signer-1" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect(signed.signer.length).toBeGreaterThan(0);
    expect(signed.signature.length).toBeGreaterThan(0);
    // Re-verify via the connector's descriptor reconstruction
    const descriptor = c.descriptorFor({
      recipient: "nW8e7eVbCgr1A3eY5n2gXfYqXq8q1qZ4Hf",
      amountKoinu: "100000000",
      reference: "REF_UNIT",
    });
    const verifySigner = new RealDogecoinSigner({ privateKey: TEST_PRIV, network: "testnet" });
    expect(verifySigner.verify(signed.signature, descriptor)).toBe(true);
  });

  it("rejects an unsupported protocol", async () => {
    const c = makeConnector();
    const userId = "signer-2" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-v9" as PaymentRequest["protocol"] }),
        session: buildSession(userId),
      })
    ).rejects.toThrow();
  });

  it("signAuthorization throws for an unknown instrument id", async () => {
    const c = makeConnector();
    const userId = "signer-3" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "ghost" as never,
        request: buildRequest(),
        session: buildSession(userId),
      })
    ).rejects.toThrow();
  });

  it("settle adapts a signed authorization into a success result", async () => {
    const c = makeConnector();
    const userId = "settle-1" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("dogecoin-testnet");
    expect(typeof result.transactionRef).toBe("string");
  });
});
