/**
 * BitcoinConnector + RealBitcoinSigner unit tests.
 *
 * Covers: capabilities, createInstrument (idempotency + empty-userId reject),
 * getBalance (+ unknown id), signAuthorization (real sig, protocol/instrument
 * guards), settle, keypair generation, address format (tb1q), sign↔verify
 * (incl. tampered-message rejection), bech32 codec round-trip.
 *
 * All offline — no network, no faucet.
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
  BitcoinConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  RealBitcoinSigner,
  generateBitcoinKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  encodeSegwitV0Address,
  decodeSegwitV0Address,
  hash160,
  canonicalTransferDescriptor,
} from "../src/index.js";

const PRIV = new Uint8Array(32).fill(9);

function makeConnector() {
  return new BitcoinConnector({
    signer: new RealBitcoinSigner({ privateKey: PRIV, network: "testnet" }),
    instrumentStore: new MemoryInstrumentStore(),
    network: "testnet",
  });
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "100000", decimals: 8, currency: "BTC" },
    recipient: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    asset: { symbol: "BTC", decimals: 8 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "100000000", decimals: 8, currency: "BTC" },
    spent: { amountAtomic: "0", decimals: 8, currency: "BTC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

describe("BitcoinConnector — capabilities", () => {
  it("reports walletProvider=bitcoin and BTC asset (8 dp)", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedAssets[0]?.symbol).toBe("BTC");
    expect(caps.supportedAssets[0]?.decimals).toBe(8);
    expect(caps.supportedProtocols[0]).toBe(PROTOCOL_ID);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["segwit"]).toBe(true);
  });
});

describe("BitcoinConnector — createInstrument", () => {
  it("creates instrument with tb1q publicHandle", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle.startsWith("tb1q")).toBe(true);
  });

  it("is idempotent for the same userId", async () => {
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

describe("BitcoinConnector — getBalance", () => {
  it("returns BTC balance in satoshis (atomic string)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "balu" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(typeof bal.money.amountAtomic).toBe("string");
    expect(bal.money.currency).toBe("BTC");
    expect(bal.money.decimals).toBe(8);
  });

  it("reads through a balanceReader when wired", async () => {
    const c = new BitcoinConnector({
      signer: new RealBitcoinSigner({
        privateKey: PRIV,
        network: "testnet",
        balanceReader: async () => 250000n,
      }),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "bru" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("250000");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(c.getBalance("nope" as InstrumentId)).rejects.toThrow(
      /Instrument not found/
    );
  });
});

describe("BitcoinConnector — signAuthorization", () => {
  it("produces a non-empty DER signature and echoes the request", async () => {
    const c = makeConnector();
    const userId = "signu" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signer.startsWith("tb1q")).toBe(true);
    expect(signed.request.recipient).toBe(req.recipient);
    expect((signed.extra?.["txid"] as string).length).toBeGreaterThan(0);
  });

  it("rejects a mismatched protocol", async () => {
    const c = makeConnector();
    const userId = "protou" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "wrong-proto-v9" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/only supports/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession("ghostu" as UserId),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("BitcoinConnector — settle", () => {
  it("returns a successful SettlementResult with txid as transactionRef", async () => {
    const c = makeConnector();
    const userId = "settleu" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.success).toBe(true);
    expect(res.network).toBe("bitcoin-testnet");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((res.transactionRef as string).length).toBeGreaterThan(0);
  });

  it("invokes a wired submit hook and uses its returned txid", async () => {
    const c = new BitcoinConnector({
      signer: new RealBitcoinSigner({
        privateKey: PRIV,
        network: "testnet",
        submit: async () => ({
          txid: "deadbeefcafe",
          explorerUrl: "https://mempool.space/testnet/tx/deadbeefcafe",
        }),
      }),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "hooku" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect(signed.extra?.["txid"]).toBe("deadbeefcafe");
    const res = await c.settle(signed);
    expect(res.transactionRef).toBe("deadbeefcafe");
  });
});

describe("RealBitcoinSigner — keygen & address format", () => {
  it("generates a fresh keypair with a tb1q testnet address", () => {
    const kp = generateBitcoinKeypair("testnet");
    expect(kp.address.startsWith("tb1q")).toBe(true);
    expect(kp.privateKeyHex.length).toBe(64);
    expect(kp.publicKeyHex.length).toBe(66); // 33 compressed bytes
    expect(kp.hash160Hex.length).toBe(40); // 20 bytes
  });

  it("derives a deterministic address from a fixed private key", () => {
    const a = keypairFromPrivateKey(PRIV, "testnet");
    const b = keypairFromHex(a.privateKeyHex, "testnet");
    expect(a.address).toBe(b.address);
    expect(a.address.startsWith("tb1q")).toBe(true);
  });

  it("mainnet keypair yields a bc1q address", () => {
    const kp = generateBitcoinKeypair("mainnet");
    expect(kp.address.startsWith("bc1q")).toBe(true);
  });
});

describe("bech32 P2WPKH codec round-trip", () => {
  it("encode then decode returns the original 20-byte program", () => {
    const program = hash160(new Uint8Array(33).fill(2));
    const addr = encodeSegwitV0Address(program, "testnet");
    expect(addr.startsWith("tb1q")).toBe(true);
    const back = decodeSegwitV0Address(addr, "testnet");
    expect(Array.from(back)).toEqual(Array.from(program));
  });

  it("decode rejects a tampered address (bad checksum)", () => {
    const program = hash160(new Uint8Array(33).fill(2));
    const addr = encodeSegwitV0Address(program, "testnet");
    const tampered = addr.slice(0, -1) + (addr.endsWith("a") ? "z" : "a");
    expect(() => decodeSegwitV0Address(tampered, "testnet")).toThrow();
  });
});

describe("RealBitcoinSigner — sign ↔ verify (real crypto)", () => {
  it("signs a descriptor and verifies it", () => {
    const signer = new RealBitcoinSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      amountSats: "100000",
      reference: "abc",
    });
    // Re-derive the signature by signing through the public API.
    return signer
      .signAndSubmit({
        recipient: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        amountSats: "100000",
        reference: "abc",
      })
      .then((res) => {
        expect(signer.verify(res.signature, descriptor)).toBe(true);
      });
  });

  it("rejects a tampered message (verify fails on altered descriptor)", async () => {
    const signer = new RealBitcoinSigner({ privateKey: PRIV, network: "testnet" });
    const res = await signer.signAndSubmit({
      recipient: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      amountSats: "100000",
      reference: "abc",
    });
    const tamperedDescriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      amountSats: "999999", // changed amount
      reference: "abc",
    });
    expect(signer.verify(res.signature, tamperedDescriptor)).toBe(false);
  });

  it("offline path returns a deterministic txid + explorer URL", async () => {
    const signer = new RealBitcoinSigner({ privateKey: PRIV, network: "testnet" });
    const a = await signer.signAndSubmit({
      recipient: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      amountSats: "100000",
      reference: "fixed",
    });
    const b = await signer.signAndSubmit({
      recipient: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      amountSats: "100000",
      reference: "fixed",
    });
    expect(a.txid).toBe(b.txid); // deterministic over identical intent
    expect(a.explorerUrl).toContain("mempool.space/testnet/tx/");
  });
});
