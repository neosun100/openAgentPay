/**
 * TronConnector + RealTronSigner unit tests.
 *
 * Covers: keygen + address format, base58check round-trip, capabilities,
 * createInstrument (idempotent + reject empty userId), getBalance, sign
 * (real verifiable secp256k1 signature + protocol/instrument errors), settle.
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
  TronConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  RealTronSigner,
  generateTronKeypair,
  keypairFromHex,
  base58CheckEncode,
  base58CheckDecode,
  addressToHex,
  canonicalTransferDescriptor,
} from "../src/index.js";

function makeConnector(opts: { balance?: bigint; submit?: boolean } = {}) {
  const signer = new RealTronSigner({
    privateKeyHex: "0".repeat(63) + "1",
    network: "nile",
    ...(opts.balance !== undefined
      ? { balanceReader: async () => opts.balance as bigint }
      : {}),
    ...(opts.submit
      ? {
          submit: async () => ({
            txId: "deadbeef".repeat(8),
            explorerUrl: "https://nile.tronscan.org/#/transaction/deadbeef",
          }),
        }
      : {}),
  });
  const connector = new TronConnector({
    signer,
    instrumentStore: new MemoryInstrumentStore(),
    network: "nile",
  });
  return { connector, signer };
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "USDT" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDT" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
    recipient: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
    asset: { symbol: "USDT", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

describe("TRON keygen + address format", () => {
  it("generateTronKeypair yields a 34-char address starting with T", () => {
    for (let i = 0; i < 20; i++) {
      const kp = generateTronKeypair();
      expect(kp.address.startsWith("T")).toBe(true);
      expect(kp.address.length).toBe(34);
      expect(kp.privateKeyHex.length).toBe(64); // 32 bytes
      expect(kp.publicKeyHex.length).toBe(130); // 65 bytes uncompressed
      expect(kp.addressHex.startsWith("41")).toBe(true); // 0x41 prefix
      expect(kp.addressHex.length).toBe(42); // 21 bytes
    }
  });

  it("keypairFromHex is deterministic for a fixed private key", () => {
    const a = keypairFromHex("0".repeat(63) + "1");
    const b = keypairFromHex("0x" + "0".repeat(63) + "1");
    expect(a.address).toBe(b.address);
    expect(a.address.startsWith("T")).toBe(true);
    expect(a.address.length).toBe(34);
  });

  it("base58check round-trips (encode→decode→same payload)", () => {
    const kp = generateTronKeypair();
    const payload = base58CheckDecode(kp.address);
    expect(payload.length).toBe(21);
    expect(payload[0]).toBe(0x41);
    expect(base58CheckEncode(payload)).toBe(kp.address);
    expect(addressToHex(kp.address)).toBe(kp.addressHex);
  });

  it("base58check rejects a corrupted address (checksum mismatch)", () => {
    const kp = generateTronKeypair();
    const broken = kp.address.slice(0, -1) + (kp.address.endsWith("a") ? "b" : "a");
    expect(() => base58CheckDecode(broken)).toThrow();
  });
});

describe("getCapabilities()", () => {
  it("reports tron provider, tron-usdt-v1 protocol, USDT+TRX assets", () => {
    const { connector } = makeConnector();
    const caps = connector.getCapabilities();
    expect(caps.walletProvider).toBe("tron");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.map((a) => a.symbol).sort()).toEqual(["TRX", "USDT"]);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["secp256k1"]).toBe(true);
  });
});

describe("createInstrument()", () => {
  it("creates an instrument whose publicHandle is the T-address", async () => {
    const { connector, signer } = makeConnector();
    const inst = await connector.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle).toBe(signer.address);
    expect(inst.publicHandle.startsWith("T")).toBe(true);
    expect(inst.walletProvider).toBe("tron");
  });

  it("is idempotent per userId", async () => {
    const { connector } = makeConnector();
    const a = await connector.createInstrument({ userId: "u2" as UserId });
    const b = await connector.createInstrument({ userId: "u2" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("throws on empty userId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

describe("getBalance()", () => {
  it("returns USDT balance with stringified atomic units", async () => {
    const { connector } = makeConnector({ balance: 12_345_678n });
    const inst = await connector.createInstrument({ userId: "bal" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("12345678");
    expect(bal.money.currency).toBe("USDT");
    expect(bal.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.getBalance("payment-instrument-tron-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

describe("signAuthorization()", () => {
  it("produces a real, verifiable secp256k1 signature", async () => {
    const { connector, signer } = makeConnector();
    const userId = "sign" as UserId;
    const inst = await connector.createInstrument({ userId });
    const req = buildRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature.length).toBe(130); // 65 bytes hex
    // Reconstruct the exact descriptor and verify cryptographically.
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      contract: (signed.extra as Record<string, unknown>)["contract"] as string | undefined ??
        "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      reference: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("rejects a mismatched protocol", async () => {
    const { connector } = makeConnector();
    const userId = "sign2" as UserId;
    const inst = await connector.createInstrument({ userId });
    await expect(
      connector.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-v9" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/tron-usdt-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.signAuthorization({
        instrumentId: "bogus" as InstrumentId,
        request: buildRequest(),
        session: buildSession("x" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("verify() rejects a tampered descriptor", async () => {
    const { signer } = makeConnector();
    const r = await signer.signAndSubmit({
      recipient: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
      amountAtomic: "1000000",
      contract: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      reference: "REF_UNIT",
    });
    expect(signer.verify(r.signature, "totally-different-message")).toBe(false);
  });
});

describe("settle()", () => {
  it("returns success with an ISO timestamp and a transactionRef", async () => {
    const { connector } = makeConnector();
    const userId = "settle" as UserId;
    const inst = await connector.createInstrument({ userId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await connector.settle(signed);
    expect(res.success).toBe(true);
    expect(res.network).toBe("tron-nile");
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof res.transactionRef).toBe("string");
    expect((res.transactionRef as string).length).toBeGreaterThan(0);
  });

  it("uses the broadcast hook's txId as transactionRef when submit is wired", async () => {
    const { connector } = makeConnector({ submit: true });
    const userId = "settle2" as UserId;
    const inst = await connector.createInstrument({ userId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const res = await connector.settle(signed);
    expect(res.success).toBe(true);
    expect(res.transactionRef).toBe("deadbeef".repeat(8));
  });
});
