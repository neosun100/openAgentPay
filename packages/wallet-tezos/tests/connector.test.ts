/**
 * wallet-tezos unit tests — crypto identity, URI parsing, connector flow.
 *
 * The signing path is REAL Ed25519 over a blake2b-256 digest of the canonical
 * descriptor; we sign-then-verify and assert a tampered message fails.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type { PaymentRequest, Session, SessionId, UserId } from "@openagentpay/core";
import {
  TezosConnector,
  TezosPayProtocolAdapter,
  MemoryInstrumentStore,
  RealTezosSigner,
  generateTezosKeypair,
  keypairFromSeed,
  keypairFromSecret,
  encodeTz1Address,
  isValidTz1Address,
  base58CheckDecode,
  PREFIX_TZ1,
  parseTezosPayUri,
  buildTezosPayUri,
  canonicalTransferDescriptor,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_TEZOS_HEADER,
} from "../src/index.js";

const SEED = new Uint8Array(32).fill(11);

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "XTZ" },
    spent: { amountAtomic: "0", decimals: 6, currency: "XTZ" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1500000", decimals: 6, currency: "XTZ" },
    recipient: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
    asset: { symbol: "XTZ", decimals: 6, chain: "tezos:mainnet" },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "abc123",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  1. Keypair / address codec
// ---------------------------------------------------------------------------

describe("Tezos keypair + tz1 address codec", () => {
  it("generates a tz1 address that starts with 'tz1' and is ~36 chars", () => {
    const kp = generateTezosKeypair();
    expect(kp.address.startsWith("tz1")).toBe(true);
    expect(kp.address.length).toBeGreaterThanOrEqual(36);
    expect(kp.address.length).toBeLessThanOrEqual(37);
    expect(kp.secret.startsWith("edsk")).toBe(true);
    expect(kp.publicKey.startsWith("edpk")).toBe(true);
  });

  it("derives a deterministic address from a fixed seed", () => {
    const a = keypairFromSeed(SEED);
    const b = keypairFromSeed(SEED);
    expect(a.address).toBe(b.address);
    expect(a.address.startsWith("tz1")).toBe(true);
  });

  it("round-trips edsk secret → keypair → same address", () => {
    const kp = keypairFromSeed(SEED);
    const loaded = keypairFromSecret(kp.secret);
    expect(loaded.address).toBe(kp.address);
    expect(loaded.secretSeedHex).toBe(kp.secretSeedHex);
  });

  it("tz1 address passes base58check decode under the tz1 prefix (20-byte hash)", () => {
    const kp = keypairFromSeed(SEED);
    const pkh = base58CheckDecode(PREFIX_TZ1, kp.address);
    expect(pkh.length).toBe(20); // blake2b-160
  });

  it("rejects a non-32-byte seed", () => {
    expect(() => keypairFromSeed(new Uint8Array(31))).toThrow();
  });

  it("isValidTz1Address accepts generated addresses, rejects junk", () => {
    const kp = generateTezosKeypair();
    expect(isValidTz1Address(kp.address)).toBe(true);
    expect(isValidTz1Address("tz1not-a-real-address")).toBe(false);
    expect(isValidTz1Address("0xdeadbeef")).toBe(false);
    expect(isValidTz1Address("")).toBe(false);
  });

  it("encodeTz1Address requires a 32-byte pubkey", () => {
    expect(() => encodeTz1Address(new Uint8Array(31))).toThrow();
  });

  it("two distinct seeds yield distinct addresses", () => {
    const a = keypairFromSeed(new Uint8Array(32).fill(1));
    const b = keypairFromSeed(new Uint8Array(32).fill(2));
    expect(a.address).not.toBe(b.address);
  });
});

// ---------------------------------------------------------------------------
//  2. Signing — REAL signature, verify + tamper-fail
// ---------------------------------------------------------------------------

describe("RealTezosSigner — real Ed25519 sign + verify", () => {
  it("signs a transfer and verifies the edsig signature", async () => {
    const signer = new RealTezosSigner({ seed: SEED });
    const res = await signer.signAndSubmit({
      recipient: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
      amountAtomic: "1500000",
      reference: "n1",
    });
    expect(res.signature.startsWith("edsig")).toBe(true);
    expect(res.signatureHex.length).toBe(128); // 64 bytes hex
    const descriptor = canonicalTransferDescriptor({
      network: "ghostnet",
      from: signer.address,
      to: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
      amountAtomic: "1500000",
      reference: "n1",
      memo: "",
    });
    expect(signer.verify(res.signature, descriptor)).toBe(true);
    expect(signer.verify(res.signatureHex, descriptor)).toBe(true);
  });

  it("fails verification on a tampered message", async () => {
    const signer = new RealTezosSigner({ seed: SEED });
    const res = await signer.signAndSubmit({
      recipient: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
      amountAtomic: "1500000",
      reference: "n1",
    });
    const tampered = canonicalTransferDescriptor({
      network: "ghostnet",
      from: signer.address,
      to: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
      amountAtomic: "9999999", // changed amount
      reference: "n1",
      memo: "",
    });
    expect(signer.verify(res.signature, tampered)).toBe(false);
  });

  it("produces deterministic signatures for the same intent (Ed25519 is deterministic)", async () => {
    const s1 = new RealTezosSigner({ seed: SEED });
    const s2 = new RealTezosSigner({ seed: SEED });
    const r1 = await s1.signAndSubmit({ recipient: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", amountAtomic: "1", reference: "x" });
    const r2 = await s2.signAndSubmit({ recipient: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", amountAtomic: "1", reference: "x" });
    expect(r1.signatureHex).toBe(r2.signatureHex);
  });

  it("verify rejects garbage signature input gracefully", () => {
    const signer = new RealTezosSigner({ seed: SEED });
    expect(signer.verify("not-a-sig", "whatever")).toBe(false);
  });

  it("routes through the pluggable submit hook when provided", async () => {
    let captured = "";
    const signer = new RealTezosSigner({
      seed: SEED,
      submit: async (input) => {
        captured = input.signer;
        return { opHash: "ooMockOpHash123", explorerUrl: "https://x/ooMockOpHash123" };
      },
    });
    const res = await signer.signAndSubmit({ recipient: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", amountAtomic: "1" });
    expect(res.opHash).toBe("ooMockOpHash123");
    expect(captured).toBe(signer.address);
  });

  it("offline-safe default: opHash falls back to the signature, no network", async () => {
    const signer = new RealTezosSigner({ seed: SEED });
    const res = await signer.signAndSubmit({ recipient: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", amountAtomic: "1" });
    expect(res.opHash).toBe(res.signature);
    expect(res.explorerUrl).toContain("tzkt.io");
  });
});

// ---------------------------------------------------------------------------
//  3. Tezos Pay URI parsing
// ---------------------------------------------------------------------------

describe("Tezos Pay URI parser", () => {
  const RECIPIENT = keypairFromSeed(SEED).address;

  it("parses a full URI", () => {
    const uri = `tezos:${RECIPIENT}?amount=1.5&ref=nonce1&label=Acme&message=Coffee`;
    const f = parseTezosPayUri(uri);
    expect(f.recipient).toBe(RECIPIENT);
    expect(f.amount).toBe("1.5");
    expect(f.reference).toBe("nonce1");
    expect(f.label).toBe("Acme");
    expect(f.message).toBe("Coffee");
  });

  it("round-trips build → parse", () => {
    const uri = buildTezosPayUri({ recipient: RECIPIENT, amount: "2.25", reference: "r9" });
    const f = parseTezosPayUri(uri);
    expect(f.recipient).toBe(RECIPIENT);
    expect(f.amount).toBe("2.25");
    expect(f.reference).toBe("r9");
  });

  it("rejects a non-tezos scheme", () => {
    expect(() => parseTezosPayUri("solana:abc")).toThrow();
  });

  it("rejects an invalid recipient", () => {
    expect(() => parseTezosPayUri("tezos:not-a-tz1?amount=1")).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  4. ProtocolAdapter
// ---------------------------------------------------------------------------

describe("TezosPayProtocolAdapter", () => {
  const RECIPIENT = keypairFromSeed(SEED).address;
  const adapter = new TezosPayProtocolAdapter({ now: () => 1_700_000_000_000 });

  it("detects a 402 carrying a tezos: URI in body.tezosPay", () => {
    expect(
      adapter.detect({
        statusCode: 402,
        headers: {},
        body: { tezosPay: `tezos:${RECIPIENT}?amount=1` },
      })
    ).toBe(true);
  });

  it("does not detect a non-402 or missing URI", () => {
    expect(adapter.detect({ statusCode: 402, headers: {}, body: {} })).toBe(false);
  });

  it("parses a 402 into a PaymentRequest with mutez atomic units", async () => {
    const req = await adapter.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { tezosPay: `tezos:${RECIPIENT}?amount=1.5&ref=xyz&message=hello` },
    });
    expect(req.protocol).toBe(PROTOCOL_ID);
    expect(req.amount.amountAtomic).toBe("1500000"); // 1.5 XTZ = 1.5M mutez
    expect(req.amount.decimals).toBe(6);
    expect(req.amount.currency).toBe("XTZ");
    expect(req.recipient).toBe(RECIPIENT);
    expect(req.nonce).toBe("xyz");
    expect(req.description).toBe("hello");
  });

  it("throws when amount is missing", async () => {
    await expect(
      adapter.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { tezosPay: `tezos:${RECIPIENT}` },
      })
    ).rejects.toThrow();
  });

  it("buildRetry attaches the X-PAYMENT-TEZOS header", async () => {
    const env = await adapter.buildRetry({
      request: buildRequest(),
      signer: RECIPIENT,
      signature: "edsigEXAMPLE",
      extra: { opHash: "ooHash" },
    });
    expect(env.headers[X_PAYMENT_TEZOS_HEADER]).toBe("edsigEXAMPLE");
    expect(env.headers["X-PAYMENT-TEZOS-OPHASH"]).toBe("ooHash");
  });
});

// ---------------------------------------------------------------------------
//  5. Connector flow
// ---------------------------------------------------------------------------

describe("TezosConnector", () => {
  function makeConnector() {
    return new TezosConnector({
      signer: new RealTezosSigner({ seed: SEED, network: "ghostnet" }),
      instrumentStore: new MemoryInstrumentStore(),
      network: "ghostnet",
    });
  }

  it("reports tezos capabilities (non-EVM, ed25519, XTZ 6dp)", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets[0]!.symbol).toBe("XTZ");
    expect(caps.supportedAssets[0]!.decimals).toBe(6);
    expect(caps.features!["ed25519"]).toBe(true);
  });

  it("createInstrument rejects empty userId", async () => {
    await expect(
      makeConnector().createInstrument({ userId: "" as UserId })
    ).rejects.toThrow();
  });

  it("createInstrument is idempotent and binds the tz1 publicHandle", async () => {
    const c = makeConnector();
    const userId = "u1" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle.startsWith("tz1")).toBe(true);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("getBalance throws for an unknown instrument id", async () => {
    await expect(
      makeConnector().getBalance("nope" as never)
    ).rejects.toThrow();
  });

  it("signAuthorization rejects the wrong protocol", async () => {
    const c = makeConnector();
    const userId = "u2" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-v9" as never }),
        session: buildSession(userId),
      })
    ).rejects.toThrow();
  });

  it("signAuthorization produces a real, verifiable edsig and settle adapts it", async () => {
    const signer = new RealTezosSigner({ seed: SEED, network: "ghostnet" });
    const c = new TezosConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "ghostnet",
    });
    const userId = "u3" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.signature.startsWith("edsig")).toBe(true);
    expect(signed.signer).toBe(signer.address);

    // The descriptor the connector signed is reproducible + verifiable.
    const descriptor = c.descriptorFor({
      recipient: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      reference: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);

    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(typeof result.transactionRef).toBe("string");
    expect(result.network).toBe("tezos-ghostnet");
    expect(result.settledAmount?.amountAtomic).toBe("1500000");
  });

  it("settle reports signature_invalid when signature is empty", async () => {
    const c = makeConnector();
    const result = await c.settle({
      request: buildRequest(),
      signer: "tz1x",
      signature: "",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});
