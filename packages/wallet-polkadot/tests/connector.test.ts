/**
 * PolkadotConnector + SS58 codec + RealPolkadotSigner unit tests.
 *
 * Covers: capabilities, instrument lifecycle, balance, sign/settle, keygen,
 * SS58 round-trip (the chain-format proof), real signature verify + tamper
 * detection, and the contract error paths.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type { PaymentRequest, ProtocolId, Session, SessionId, UserId } from "@openagentpay/core";
import {
  PolkadotConnector,
  DemoPolkadotSigner,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  DOT_DECIMALS,
  USDT_DECIMALS,
  RealPolkadotSigner,
  generatePolkadotKeypair,
  keypairFromSeed,
  keypairFromSeedHex,
  publicKeypairFromAddress,
  canonicalTransferDescriptor,
  ss58Encode,
  ss58Decode,
  isValidSs58,
  SS58_PREFIX_POLKADOT,
  SS58_PREFIX_SUBSTRATE,
} from "../src/index.js";

const SEED = new Uint8Array(32).fill(7);

function makeConnector(opts?: { balanceAtomic?: string; defaultAsset?: string }) {
  const signer = new RealPolkadotSigner({ seed: SEED, network: "westend" });
  const store = new MemoryInstrumentStore();
  const connector = new PolkadotConnector({
    signer,
    instrumentStore: store,
    network: "westend",
    ...(opts?.defaultAsset ? { defaultAsset: opts.defaultAsset } : {}),
  });
  return { signer, store, connector };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "10000000000", decimals: 10, currency: "DOT" },
    recipient: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    asset: { symbol: "DOT", decimals: 10 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "NONCE_1",
    rawPayload: {},
    ...overrides,
  };
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000000", decimals: 10, currency: "DOT" },
    spent: { amountAtomic: "0", decimals: 10, currency: "DOT" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

// ---------------------------------------------------------------------------
//  getCapabilities
// ---------------------------------------------------------------------------
describe("getCapabilities()", () => {
  it("reports polkadot provider + both protocol & assets", () => {
    const { connector } = makeConnector();
    const caps = connector.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    const symbols = caps.supportedAssets.map((a) => a.symbol);
    expect(symbols).toContain("DOT");
    expect(symbols).toContain("USDt");
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["ed25519"]).toBe(true);
    expect(caps.features?.["ss58"]).toBe(true);
  });

  it("DOT has 10 decimals, USDt has 6 decimals", () => {
    const { connector } = makeConnector();
    const assets = connector.getCapabilities().supportedAssets;
    expect(assets.find((a) => a.symbol === "DOT")?.decimals).toBe(DOT_DECIMALS);
    expect(assets.find((a) => a.symbol === "USDt")?.decimals).toBe(USDT_DECIMALS);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------
describe("createInstrument()", () => {
  it("creates an instrument whose publicHandle is the signer SS58 address", async () => {
    const { connector, signer } = makeConnector();
    const inst = await connector.createInstrument({ userId: "u1" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(signer.address);
    expect(isValidSs58(inst.publicHandle)).toBe(true);
  });

  it("is idempotent per userId", async () => {
    const { connector } = makeConnector();
    const a = await connector.createInstrument({ userId: "same" as UserId });
    const b = await connector.createInstrument({ userId: "same" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("rejects empty userId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------
describe("getBalance()", () => {
  it("returns DOT balance (10 decimals) via signer balanceReader", async () => {
    const signer = new RealPolkadotSigner({
      seed: SEED,
      network: "westend",
      balanceReader: async () => 42_0000000000n,
    });
    const connector = new PolkadotConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "westend",
    });
    const inst = await connector.createInstrument({ userId: "bal" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.currency).toBe("DOT");
    expect(bal.money.decimals).toBe(DOT_DECIMALS);
    expect(BigInt(bal.money.amountAtomic)).toBe(42_0000000000n);
    expect(bal.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses 6 decimals when defaultAsset is USDt", async () => {
    const signer = new RealPolkadotSigner({
      seed: SEED,
      balanceReader: async () => 5_000000n,
    });
    const connector = new PolkadotConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      defaultAsset: "USDt",
    });
    const inst = await connector.createInstrument({ userId: "u" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.money.decimals).toBe(USDT_DECIMALS);
    expect(bal.money.currency).toBe("USDt");
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.getBalance("payment-instrument-nope" as never)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization + settle
// ---------------------------------------------------------------------------
describe("signAuthorization() + settle()", () => {
  it("produces a real, verifiable Ed25519 signature echoing the request", async () => {
    const { connector, signer } = makeConnector();
    const userId = "signer" as UserId;
    const inst = await connector.createInstrument({ userId });
    const req = buildRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature.length).toBeGreaterThan(0);

    // The signature must verify against the canonical descriptor.
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      assetSymbol: "DOT",
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("verify() rejects a tampered message", async () => {
    const { connector, signer } = makeConnector();
    const userId = "tamper" as UserId;
    const inst = await connector.createInstrument({ userId });
    const req = buildRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.address,
      to: req.recipient,
      amountAtomic: "99999999999", // attacker bumps the amount
      assetSymbol: "DOT",
    });
    expect(signer.verify(signed.signature, tampered)).toBe(false);
  });

  it("rejects a non-polkadot protocol", async () => {
    const { connector } = makeConnector();
    const userId = "wrongproto" as UserId;
    const inst = await connector.createInstrument({ userId });
    await expect(
      connector.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "x402-v1" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/only supports polkadot-pay-v1/);
  });

  it("signAuthorization throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.signAuthorization({
        instrumentId: "bogus" as never,
        request: buildRequest(),
        session: buildSession("x" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("settle() returns success with an on-chain-style transactionRef + ISO settledAt", async () => {
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
    expect(res.network).toBe("polkadot-westend");
    expect(typeof res.transactionRef).toBe("string");
    expect((res.transactionRef as string).startsWith("0x")).toBe(true);
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("settle() fails gracefully with canonical errorCode on empty signature", async () => {
    const { connector } = makeConnector();
    const res = await connector.settle({
      request: buildRequest(),
      signer: "5xxx",
      signature: "",
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });

  it("wires the optional submit hook (broadcast path)", async () => {
    let called = false;
    const signer = new RealPolkadotSigner({
      seed: SEED,
      submit: async (input) => {
        called = true;
        expect(input.signer).toBe(signer.address);
        return {
          blockHash: "0xfeedface",
          explorerUrl: "https://westend.subscan.io/extrinsic/0xfeedface",
        };
      },
    });
    const connector = new PolkadotConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "hook" as UserId;
    const inst = await connector.createInstrument({ userId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect(called).toBe(true);
    const res = await connector.settle(signed);
    expect(res.transactionRef).toBe("0xfeedface");
  });
});

// ---------------------------------------------------------------------------
//  Keygen + SS58 codec (chain-format proof)
// ---------------------------------------------------------------------------
describe("keygen + SS58 codec", () => {
  it("generatePolkadotKeypair yields valid SS58 forms", () => {
    const kp = generatePolkadotKeypair();
    expect(kp.addressPolkadot[0]).toBe("1"); // relay prefix 0
    expect(kp.addressSubstrate[0]).toBe("5"); // generic prefix 42
    expect(isValidSs58(kp.addressPolkadot)).toBe(true);
    expect(isValidSs58(kp.addressSubstrate)).toBe(true);
    expect(kp.secretSeedHex.length).toBe(64); // 32 bytes hex
    expect(kp.publicKeyHex.length).toBe(64);
  });

  it("keypairFromSeed is deterministic", () => {
    const a = keypairFromSeed(SEED);
    const b = keypairFromSeed(SEED);
    expect(a.address).toBe(b.address);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
  });

  it("keypairFromSeedHex round-trips with keypairFromSeed", () => {
    const a = keypairFromSeed(SEED);
    const b = keypairFromSeedHex(a.secretSeedHex);
    expect(a.address).toBe(b.address);
  });

  it("SS58 round-trips: encode→decode recovers prefix + pubkey", () => {
    const kp = keypairFromSeed(SEED);
    const pub = hexToBytes(kp.publicKeyHex);
    for (const prefix of [SS58_PREFIX_POLKADOT, SS58_PREFIX_SUBSTRATE, 2]) {
      const addr = ss58Encode(pub, prefix);
      const dec = ss58Decode(addr);
      expect(dec.prefix).toBe(prefix);
      expect(toHex(dec.pubkey)).toBe(kp.publicKeyHex);
    }
  });

  it("publicKeypairFromAddress recovers the pubkey from an SS58 address", () => {
    const kp = keypairFromSeed(SEED);
    const pubOnly = publicKeypairFromAddress(kp.addressSubstrate);
    expect(pubOnly.publicKeyHex).toBe(kp.publicKeyHex);
    expect(pubOnly.addressPolkadot).toBe(kp.addressPolkadot);
  });

  it("ss58Decode throws on a checksum-corrupted address", () => {
    const kp = keypairFromSeed(SEED);
    // flip the last base58 char to break the checksum
    const addr = kp.addressSubstrate;
    const lastChar = addr.slice(-1) === "A" ? "B" : "A";
    const corrupted = addr.slice(0, -1) + lastChar;
    expect(isValidSs58(corrupted)).toBe(false);
    expect(() => ss58Decode(corrupted)).toThrow();
  });

  it("ss58Encode rejects wrong-length pubkeys", () => {
    expect(() => ss58Encode(new Uint8Array(31), 0)).toThrow(/32 bytes/);
  });
});

// ---------------------------------------------------------------------------
//  Demo signer (lightweight, no crypto) — sanity only
// ---------------------------------------------------------------------------
describe("DemoPolkadotSigner", () => {
  it("connects and settles with a fake signer (Alice dev key)", async () => {
    const signer = new DemoPolkadotSigner({ initialBalanceAtomic: "100" });
    const connector = new PolkadotConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await connector.createInstrument({ userId: "demo" as UserId });
    expect(inst.publicHandle[0]).toBe("5");
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("demo" as UserId),
    });
    const res = await connector.settle(signed);
    expect(res.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  local hex helpers (mirror real-signer internals)
// ---------------------------------------------------------------------------
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
