/**
 * LitecoinConnector + RealLitecoinSigner unit tests.
 *
 * Covers: capabilities, createInstrument (idempotency + empty-userId reject),
 * getBalance (+ unknown id), signAuthorization (real sig, protocol/instrument
 * guards), settle, keypair generation, address format (tltc1q), sign↔verify
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
  LitecoinConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  RealLitecoinSigner,
  generateLitecoinKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  encodeSegwitV0Address,
  decodeSegwitV0Address,
  hash160,
  canonicalTransferDescriptor,
} from "../src/index.js";

const PRIV = new Uint8Array(32).fill(9);

// A real tltc1q… recipient, derived in-process from the canonical BIP-173
// test-vector witness program so we never hardcode a guessed checksum.
const RECIPIENT = encodeSegwitV0Address(
  hash160(new Uint8Array(33).fill(3)),
  "testnet"
);

function makeConnector() {
  return new LitecoinConnector({
    signer: new RealLitecoinSigner({ privateKey: PRIV, network: "testnet" }),
    instrumentStore: new MemoryInstrumentStore(),
    network: "testnet",
  });
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "100000", decimals: 8, currency: "LTC" },
    recipient: RECIPIENT,
    asset: { symbol: "LTC", decimals: 8 },
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
    budget: { amountAtomic: "100000000", decimals: 8, currency: "LTC" },
    spent: { amountAtomic: "0", decimals: 8, currency: "LTC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

describe("LitecoinConnector — capabilities", () => {
  it("reports walletProvider=litecoin and LTC asset (8 dp)", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedAssets[0]?.symbol).toBe("LTC");
    expect(caps.supportedAssets[0]?.decimals).toBe(8);
    expect(caps.supportedProtocols[0]).toBe(PROTOCOL_ID);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["segwit"]).toBe(true);
  });
});

describe("LitecoinConnector — createInstrument", () => {
  it("creates instrument with tltc1q publicHandle", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle.startsWith("tltc1q")).toBe(true);
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

describe("LitecoinConnector — getBalance", () => {
  it("returns LTC balance in litoshis (atomic string)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "balu" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(typeof bal.money.amountAtomic).toBe("string");
    expect(bal.money.currency).toBe("LTC");
    expect(bal.money.decimals).toBe(8);
  });

  it("reads through a balanceReader when wired", async () => {
    const c = new LitecoinConnector({
      signer: new RealLitecoinSigner({
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

describe("LitecoinConnector — signAuthorization", () => {
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
    expect(signed.signer.startsWith("tltc1q")).toBe(true);
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

describe("LitecoinConnector — settle", () => {
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
    expect(res.network).toBe("litecoin-testnet");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((res.transactionRef as string).length).toBeGreaterThan(0);
  });

  it("invokes a wired submit hook and uses its returned txid", async () => {
    const c = new LitecoinConnector({
      signer: new RealLitecoinSigner({
        privateKey: PRIV,
        network: "testnet",
        submit: async () => ({
          txid: "deadbeefcafe",
          explorerUrl: "https://blockchair.com/litecoin/testnet/transaction/deadbeefcafe",
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

describe("RealLitecoinSigner — keygen & address format", () => {
  it("generates a fresh keypair with a tltc1q testnet address", () => {
    const kp = generateLitecoinKeypair("testnet");
    expect(kp.address.startsWith("tltc1q")).toBe(true);
    expect(kp.privateKeyHex.length).toBe(64);
    expect(kp.publicKeyHex.length).toBe(66); // 33 compressed bytes
    expect(kp.hash160Hex.length).toBe(40); // 20 bytes
  });

  it("derives a deterministic address from a fixed private key", () => {
    const a = keypairFromPrivateKey(PRIV, "testnet");
    const b = keypairFromHex(a.privateKeyHex, "testnet");
    expect(a.address).toBe(b.address);
    expect(a.address.startsWith("tltc1q")).toBe(true);
  });

  it("mainnet keypair yields an ltc1q address", () => {
    const kp = generateLitecoinKeypair("mainnet");
    expect(kp.address.startsWith("ltc1q")).toBe(true);
  });
});

describe("bech32 P2WPKH codec round-trip", () => {
  it("encode then decode returns the original 20-byte program", () => {
    const program = hash160(new Uint8Array(33).fill(2));
    const addr = encodeSegwitV0Address(program, "testnet");
    expect(addr.startsWith("tltc1q")).toBe(true);
    const back = decodeSegwitV0Address(addr, "testnet");
    expect(Array.from(back)).toEqual(Array.from(program));
  });

  it("decode rejects a tampered address (bad checksum)", () => {
    const program = hash160(new Uint8Array(33).fill(2));
    const addr = encodeSegwitV0Address(program, "testnet");
    const tampered = addr.slice(0, -1) + (addr.endsWith("a") ? "z" : "a");
    expect(() => decodeSegwitV0Address(tampered, "testnet")).toThrow();
  });

  it("decode rejects a mainnet (ltc) address under testnet hrp", () => {
    const program = hash160(new Uint8Array(33).fill(2));
    const mainnetAddr = encodeSegwitV0Address(program, "mainnet");
    expect(() => decodeSegwitV0Address(mainnetAddr, "testnet")).toThrow(
      /hrp mismatch/
    );
  });
});

describe("RealLitecoinSigner — sign ↔ verify (real crypto)", () => {
  it("signs a descriptor and verifies it", () => {
    const signer = new RealLitecoinSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountLitoshis: "100000",
      reference: "abc",
    });
    // Re-derive the signature by signing through the public API.
    return signer
      .signAndSubmit({
        recipient: RECIPIENT,
        amountLitoshis: "100000",
        reference: "abc",
      })
      .then((res) => {
        expect(signer.verify(res.signature, descriptor)).toBe(true);
      });
  });

  it("rejects a tampered message (verify fails on altered descriptor)", async () => {
    const signer = new RealLitecoinSigner({ privateKey: PRIV, network: "testnet" });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountLitoshis: "100000",
      reference: "abc",
    });
    const tamperedDescriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountLitoshis: "999999", // changed amount
      reference: "abc",
    });
    expect(signer.verify(res.signature, tamperedDescriptor)).toBe(false);
  });

  it("offline path returns a deterministic txid + explorer URL", async () => {
    const signer = new RealLitecoinSigner({ privateKey: PRIV, network: "testnet" });
    const a = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountLitoshis: "100000",
      reference: "fixed",
    });
    const b = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountLitoshis: "100000",
      reference: "fixed",
    });
    expect(a.txid).toBe(b.txid); // deterministic over identical intent
    expect(a.explorerUrl).toContain("blockchair.com/litecoin/testnet/transaction/");
  });
});
