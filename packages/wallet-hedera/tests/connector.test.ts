/**
 * Unit tests for HederaConnector + RealHederaSigner + keypair helpers.
 *
 * Fully offline: real Ed25519 crypto, deterministic seeds, no network.
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
  HederaConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  HTS_USDC_TOKEN_ID,
  RealHederaSigner,
  generateHederaKeypair,
  keypairFromSeed,
  keypairFromDer,
  derivePrivateKeyDer,
  deriveMockAccountId,
  canonicalTransferDescriptor,
  HEDERA_ED25519_DER_PREFIX,
} from "../src/index.js";

const SEED = new Uint8Array(32).fill(7);

function mkConnector(opts?: { balance?: bigint }) {
  const signer = new RealHederaSigner({
    seed: SEED,
    network: "testnet",
    ...(opts?.balance !== undefined
      ? { balanceReader: async () => opts.balance! }
      : {}),
  });
  const store = new MemoryInstrumentStore();
  const connector = new HederaConnector({
    signer,
    instrumentStore: store,
    network: "testnet",
  });
  return { signer, store, connector };
}

function mkSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function mkRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: PROTOCOL_ID as unknown as ProtocolId,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
    recipient: "0.0.800",
    asset: { symbol: "USDC", decimals: 6, contract: HTS_USDC_TOKEN_ID },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "nonce-unit-1",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Keypair helpers
// ---------------------------------------------------------------------------

describe("keypair helpers", () => {
  it("derivePrivateKeyDer produces the canonical Hedera Ed25519 DER prefix", () => {
    const kp = keypairFromSeed(SEED);
    expect(kp.privateKeyDer.startsWith(HEDERA_ED25519_DER_PREFIX)).toBe(true);
    expect(kp.privateKeyDer.length).toBe(HEDERA_ED25519_DER_PREFIX.length + 64);
    // Standalone helper agrees with keypairFromSeed.
    expect(derivePrivateKeyDer(SEED)).toBe(kp.privateKeyDer);
  });

  it("generateHederaKeypair yields valid distinct random keypairs", () => {
    const a = generateHederaKeypair();
    const b = generateHederaKeypair();
    expect(a.seedHex).not.toBe(b.seedHex);
    expect(a.publicKeyHex.length).toBe(64);
    expect(a.accountId).toMatch(/^0\.0\.\d+$/);
    expect(a.privateKeyDer.startsWith(HEDERA_ED25519_DER_PREFIX)).toBe(true);
  });

  it("deriveMockAccountId is deterministic and above reserved range", () => {
    const kp = keypairFromSeed(SEED);
    const accNum = Number(kp.accountId.split(".")[2]);
    expect(kp.accountId).toMatch(/^0\.0\.\d+$/);
    expect(accNum).toBeGreaterThanOrEqual(1001);
    // pubkey-derived → stable
    expect(deriveMockAccountId(new Uint8Array(Buffer.from(kp.publicKeyHex, "hex")))).toBe(
      kp.accountId
    );
  });

  it("keypairFromDer round-trips a DER private key string", () => {
    const kp = keypairFromSeed(SEED);
    const back = keypairFromDer(kp.privateKeyDer);
    expect(back.seedHex).toBe(kp.seedHex);
    expect(back.publicKeyHex).toBe(kp.publicKeyHex);
    expect(back.accountId).toBe(kp.accountId);
  });

  it("keypairFromDer also accepts a bare 32-byte seed hex", () => {
    const kp = keypairFromSeed(SEED);
    const back = keypairFromDer(kp.seedHex);
    expect(back.publicKeyHex).toBe(kp.publicKeyHex);
  });

  it("keypairFromSeed rejects wrong-length seeds", () => {
    expect(() => keypairFromSeed(new Uint8Array(31))).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  getCapabilities
// ---------------------------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports hedera provider, both assets, and the hedera-hcs-v1 protocol", () => {
    const { connector } = mkConnector();
    const caps = connector.getCapabilities();
    expect(caps.walletProvider).toBe("hedera");
    expect(caps.settlesOnChain).toBe(true);
    const symbols = caps.supportedAssets.map((a) => a.symbol).sort();
    expect(symbols).toEqual(["HBAR", "USDC"]);
    const hbar = caps.supportedAssets.find((a) => a.symbol === "HBAR");
    const usdc = caps.supportedAssets.find((a) => a.symbol === "USDC");
    expect(hbar?.decimals).toBe(8);
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.contract).toBe(HTS_USDC_TOKEN_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("creates an instrument with a 0.0.x publicHandle + ed25519 metadata", async () => {
    const { connector, signer } = mkConnector();
    const inst = await connector.createInstrument({
      userId: "u-create" as UserId,
    });
    expect(inst.walletProvider).toBe("hedera");
    expect(inst.publicHandle).toBe(signer.accountId);
    expect(inst.publicHandle).toMatch(/^0\.0\.\d+$/);
    expect(inst.providerMetadata?.["keyType"]).toBe("ed25519");
    expect(inst.providerMetadata?.["publicKeyHex"]).toBe(signer.publicKeyHex);
  });

  it("is idempotent per userId", async () => {
    const { connector } = mkConnector();
    const a = await connector.createInstrument({ userId: "u-idem" as UserId });
    const b = await connector.createInstrument({ userId: "u-idem" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("throws on empty userId", async () => {
    const { connector } = mkConnector();
    await expect(
      connector.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("getBalance()", () => {
  it("returns a USDC balance via the balanceReader", async () => {
    const { connector } = mkConnector({ balance: 4200000n });
    const inst = await connector.createInstrument({ userId: "u-bal" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("4200000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.asset.contract).toBe(HTS_USDC_TOKEN_ID);
    expect(bal.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = mkConnector();
    await expect(
      connector.getBalance("payment-instrument-hedera-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable Ed25519 signature and echoes the request", async () => {
    const { connector, signer } = mkConnector();
    const userId = "u-sign" as UserId;
    const inst = await connector.createInstrument({ userId });
    const req = mkRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: mkSession(userId),
    });
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signer).toBe(signer.accountId);
    expect(signed.request.recipient).toBe(req.recipient);

    // The signature must verify against the canonical descriptor.
    const descriptor = canonicalTransferDescriptor({
      from: signer.accountId,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      tokenId: HTS_USDC_TOKEN_ID,
      nonce: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("signs native HBAR transfers without a token id", async () => {
    const { connector, signer } = mkConnector();
    const userId = "u-hbar" as UserId;
    const inst = await connector.createInstrument({ userId });
    const req = mkRequest({
      amount: { amountAtomic: "500000000", decimals: 8, currency: "HBAR" },
      asset: { symbol: "HBAR", decimals: 8 },
    });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: mkSession(userId),
    });
    const descriptor = canonicalTransferDescriptor({
      from: signer.accountId,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      nonce: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("rejects an unsupported protocol", async () => {
    const { connector } = mkConnector();
    const userId = "u-badproto" as UserId;
    const inst = await connector.createInstrument({ userId });
    await expect(
      connector.signAuthorization({
        instrumentId: inst.id,
        request: mkRequest({ protocol: "bogus-v9" as ProtocolId }),
        session: mkSession(userId),
      })
    ).rejects.toThrow(/only supports/);
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = mkConnector();
    const userId = "u-noinst" as UserId;
    await expect(
      connector.signAuthorization({
        instrumentId: "payment-instrument-hedera-ghost" as InstrumentId,
        request: mkRequest(),
        session: mkSession(userId),
      })
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("settle()", () => {
  it("returns success with a Hedera-shaped transactionRef + network", async () => {
    const { connector } = mkConnector();
    const userId = "u-settle" as UserId;
    const inst = await connector.createInstrument({ userId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: mkRequest(),
      session: mkSession(userId),
    });
    const res = await connector.settle(signed);
    expect(res.success).toBe(true);
    expect(res.network).toBe("hedera-testnet");
    expect(typeof res.transactionRef).toBe("string");
    expect(res.transactionRef as string).toMatch(/^0\.0\.\d+@\d+\.\d+$/);
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fails with signature_invalid when the signature is empty", async () => {
    const { connector } = mkConnector();
    const userId = "u-settlebad" as UserId;
    const inst = await connector.createInstrument({ userId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: mkRequest(),
      session: mkSession(userId),
    });
    const tampered = { ...signed, signature: "" };
    const res = await connector.settle(tampered);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });

  it("fails with signature_invalid when the signature is forged", async () => {
    const { connector } = mkConnector();
    const userId = "u-forge" as UserId;
    const inst = await connector.createInstrument({ userId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: mkRequest(),
      session: mkSession(userId),
    });
    // Flip the signature to a syntactically valid but wrong 64-byte hex.
    const forged = { ...signed, signature: "ab".repeat(64) };
    const res = await connector.settle(forged);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });
});
