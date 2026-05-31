/**
 * Tests for @openagentpay/wallet-flow — Flow (Cadence) wallet connector.
 *
 * Covers: keypair generation + address format, real secp256k1 sign/verify,
 * tampered-message rejection, connector lifecycle, protocol guards, settle.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  FlowConnector,
  MemoryInstrumentStore,
  RealFlowSigner,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  FLOW_TOKEN_CONTRACT,
  FLOW_USDC_CONTRACT,
  generateFlowKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  pubkeyToMockAddress,
  isValidFlowAddress,
  normalizeFlowAddress,
  canonicalTransferDescriptor,
  FLOW_ADDRESS_RE,
} from "../src/index.js";
import type {
  PaymentRequest,
  Session,
  SessionId,
  UserId,
  InstrumentId,
  ProtocolId,
} from "@openagentpay/core";

const TEST_PRIV = new Uint8Array(32).fill(7);
const RECIPIENT = "0x1cf0e2f2f715450c";

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 8, currency: "FLOW" },
    spent: { amountAtomic: "0", decimals: 8, currency: "FLOW" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequestDefaults(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "100000000", decimals: 8, currency: "FLOW" },
    recipient: RECIPIENT,
    asset: { symbol: "FLOW", decimals: 8 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF1",
    rawPayload: {},
    ...overrides,
  };
}

function makeConnector() {
  return new FlowConnector({
    signer: new RealFlowSigner({ privateKey: TEST_PRIV, network: "testnet" }),
    instrumentStore: new MemoryInstrumentStore(),
    network: "testnet",
  });
}

// ----------------------------------------------------------------------------
//  Keypair + address format
// ----------------------------------------------------------------------------

describe("keypair + address", () => {
  it("generates a real secp256k1 keypair with a 0x+16-hex address", () => {
    const kp = generateFlowKeypair();
    expect(kp.privateKeyHex.length).toBe(64); // 32 bytes
    expect(kp.publicKeyHex.startsWith("04")).toBe(true); // uncompressed
    expect(kp.flowPublicKeyHex.length).toBe(128); // 64-byte X||Y
    expect(FLOW_ADDRESS_RE.test(kp.address)).toBe(true);
    expect(isValidFlowAddress(kp.address)).toBe(true);
  });

  it("address is deterministic for a fixed private key", () => {
    const a = keypairFromPrivateKey(TEST_PRIV);
    const b = keypairFromPrivateKey(TEST_PRIV);
    expect(a.address).toBe(b.address);
    expect(a.address).toBe(pubkeyToMockAddress(hexToBytes(a.publicKeyHex)));
  });

  it("keypairFromHex round-trips with/without 0x prefix", () => {
    const kp = generateFlowKeypair();
    const viaPlain = keypairFromHex(kp.privateKeyHex);
    const via0x = keypairFromHex("0x" + kp.privateKeyHex);
    expect(viaPlain.address).toBe(kp.address);
    expect(via0x.address).toBe(kp.address);
  });

  it("rejects a wrong-length private key", () => {
    expect(() => keypairFromPrivateKey(new Uint8Array(31))).toThrowError(/32 bytes/);
  });

  it("normalizeFlowAddress zero-pads and lowercases", () => {
    expect(normalizeFlowAddress("0xABC")).toBe("0x0000000000000abc");
    expect(normalizeFlowAddress("1cf0e2f2f715450c")).toBe("0x1cf0e2f2f715450c");
  });

  it("isValidFlowAddress rejects malformed handles", () => {
    expect(isValidFlowAddress("0x123")).toBe(false); // too short
    expect(isValidFlowAddress("1cf0e2f2f715450c")).toBe(false); // no 0x
    expect(isValidFlowAddress("0xZZZZe2f2f715450c")).toBe(false); // non-hex
  });
});

// ----------------------------------------------------------------------------
//  Real signature verification
// ----------------------------------------------------------------------------

describe("RealFlowSigner signing", () => {
  it("produces a real secp256k1 signature that verifies", () => {
    const signer = new RealFlowSigner({ privateKey: TEST_PRIV });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "100000000",
      tokenContract: FLOW_TOKEN_CONTRACT,
      reference: "REF1",
    });
    const sig = signer.signDescriptor(descriptor);
    expect(sig.length).toBe(128); // 64-byte r||s
    expect(signer.verify(sig, descriptor)).toBe(true);
  });

  it("fails verification on a tampered message", () => {
    const signer = new RealFlowSigner({ privateKey: TEST_PRIV });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "100000000",
      tokenContract: FLOW_TOKEN_CONTRACT,
      reference: "REF1",
    });
    const sig = signer.signDescriptor(descriptor);
    const tampered = descriptor.replace("100000000", "999999999");
    expect(signer.verify(sig, tampered)).toBe(false);
  });

  it("fails verification on a tampered signature", () => {
    const signer = new RealFlowSigner({ privateKey: TEST_PRIV });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "1",
    });
    const sig = signer.signDescriptor(descriptor);
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(signer.verify(flipped, descriptor)).toBe(false);
  });

  it("signAndSubmit offline default returns real sig + deterministic empty blockId", async () => {
    const signer = new RealFlowSigner({ privateKey: TEST_PRIV, network: "testnet" });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "100000000",
      tokenContract: FLOW_TOKEN_CONTRACT,
      reference: "REF1",
    });
    expect(res.signature.length).toBe(128);
    expect(res.blockId).toBe("");
    expect(res.explorerUrl).toMatch(/testnet\.flowscan\.io/);
  });

  it("routes broadcast through a pluggable submit hook when provided", async () => {
    let called = false;
    const signer = new RealFlowSigner({
      privateKey: TEST_PRIV,
      submit: async (input) => {
        called = true;
        expect(input.signer.startsWith("0x")).toBe(true);
        return { blockId: "block-123", explorerUrl: "https://x/tx/block-123" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1",
    });
    expect(called).toBe(true);
    expect(res.blockId).toBe("block-123");
  });
});

// ----------------------------------------------------------------------------
//  Connector lifecycle
// ----------------------------------------------------------------------------

describe("FlowConnector", () => {
  it("reports stable capabilities with <=24-decimal assets", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toEqual([PROTOCOL_ID]);
    expect(caps.settlesOnChain).toBe(true);
    for (const a of caps.supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
  });

  it("createInstrument throws on empty userId", async () => {
    const c = makeConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(/userId/);
  });

  it("createInstrument is idempotent and stores pubkey in providerMetadata", async () => {
    const c = makeConnector();
    const userId = "u1" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(FLOW_ADDRESS_RE.test(a.publicHandle)).toBe(true);
    const meta = a.providerMetadata as Record<string, unknown>;
    expect(typeof meta["publicKeyHex"]).toBe("string");
    expect(meta["signatureAlgorithm"]).toBe("ECDSA_secp256k1");
  });

  it("getBalance throws on unknown instrument id", async () => {
    const c = makeConnector();
    await expect(c.getBalance("nope" as InstrumentId)).rejects.toThrow(/not found/);
  });

  it("getBalance returns offline-safe zero FLOW balance", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.currency).toBe("FLOW");
    expect(bal.money.decimals).toBe(8);
    expect(BigInt(bal.money.amountAtomic)).toBe(0n);
  });

  it("getBalance reports USDC when default token is USDCFlow", async () => {
    const c = new FlowConnector({
      signer: new RealFlowSigner({ privateKey: TEST_PRIV }),
      instrumentStore: new MemoryInstrumentStore(),
      defaultTokenContract: FLOW_USDC_CONTRACT,
    });
    const inst = await c.createInstrument({ userId: "uu" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.currency).toBe("USDC");
    expect(bal.money.decimals).toBe(6);
  });

  it("signAuthorization produces a verifiable signature and echoes the request", async () => {
    const c = makeConnector();
    const userId = "signer" as UserId;
    const inst = await c.createInstrument({ userId });
    const request = buildRequestDefaults();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request,
      session: buildSession(userId),
    });
    expect(signed.signature.length).toBe(128);
    expect(signed.request.recipient).toBe(RECIPIENT);
    expect(FLOW_ADDRESS_RE.test(signed.signer)).toBe(true);
    // the connector can recompute the descriptor and the signer verifies it
    const verifier = new RealFlowSigner({ privateKey: TEST_PRIV });
    expect(verifier.verify(signed.signature, c.descriptorFor(signed))).toBe(true);
  });

  it("signAuthorization rejects a wrong protocol", async () => {
    const c = makeConnector();
    const userId = "p" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequestDefaults({ protocol: "x402-v1" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/flow-pay-v1/);
  });

  it("signAuthorization throws on unknown instrument id", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "ghost" as InstrumentId,
        request: buildRequestDefaults(),
        session: buildSession("g" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("settle adapts the signed authorization into a successful result", async () => {
    const c = makeConnector();
    const userId = "s" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequestDefaults(),
      session: buildSession(userId),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("flow-testnet");
    expect(result.transactionRef).toBe(signed.signature);
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("settle fails gracefully on a missing signature", async () => {
    const c = makeConnector();
    const userId = "s2" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequestDefaults(),
      session: buildSession(userId),
    });
    const broken = { ...signed, signature: "" };
    const result = await c.settle(broken);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("USDC request routes the USDCFlow token contract into the descriptor", async () => {
    const c = makeConnector();
    const userId = "usdc" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequestDefaults({
        amount: { amountAtomic: "5000000", decimals: 6, currency: "USDC" },
        asset: { symbol: "USDC", decimals: 6, contract: FLOW_USDC_CONTRACT },
      }),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["tokenContract"]).toBe(
      FLOW_USDC_CONTRACT
    );
    expect(c.descriptorFor(signed)).toContain("token=USDCFlow");
  });
});

// ----------------------------------------------------------------------------
//  local hex helper for tests
// ----------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
