/**
 * Tests for @openagentpay/wallet-monero — Monero identity + auth layer.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  MoneroConnector,
  MemoryInstrumentStore,
  createMoneroConnector,
  parseMoneroUri,
  buildMoneroUri,
  xmrToAtomic,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  XMR_DECIMALS,
  RealMoneroSigner,
  generateMoneroKeypair,
  keypairFromSecrets,
  encodeMoneroAddress,
  decodeMoneroAddress,
  isValidMoneroAddress,
  canonicalTransferDescriptor,
  MONERO_NETWORK_BYTE,
} from "../src/index.js";
import type { PaymentRequest, Session, UserId } from "@openagentpay/core";

const RECIPIENT = generateMoneroKeypair("testnet").address;

function buildReq(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "500000000000", decimals: XMR_DECIMALS, currency: "XMR" },
    recipient: RECIPIENT,
    asset: { symbol: "XMR", decimals: XMR_DECIMALS },
    validAfter: 0,
    validBefore: 9_999_999_999,
    nonce: "deadbeefdeadbeef",
    rawPayload: {},
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
//  Address codec
// ----------------------------------------------------------------------------

describe("Monero address codec", () => {
  it("generates a testnet address that decodes back to the two pubkeys", () => {
    const kp = generateMoneroKeypair("testnet");
    expect(isValidMoneroAddress(kp.address)).toBe(true);
    const decoded = decodeMoneroAddress(kp.address);
    expect(decoded.network).toBe("testnet");
    expect(decoded.networkByte).toBe(MONERO_NETWORK_BYTE.testnet);
    expect(bytesToHex(decoded.spendPub)).toBe(kp.spendPubHex);
    expect(bytesToHex(decoded.viewPub)).toBe(kp.viewPubHex);
  });

  it("encode → decode is a faithful round-trip", () => {
    const kp = generateMoneroKeypair("mainnet");
    const decoded = decodeMoneroAddress(kp.address);
    const reencoded = encodeMoneroAddress(decoded.spendPub, decoded.viewPub, "mainnet");
    expect(reencoded).toBe(kp.address);
  });

  it("rejects a tampered address (checksum mismatch)", () => {
    const kp = generateMoneroKeypair("testnet");
    // Flip one character in the middle to corrupt the payload.
    const mid = Math.floor(kp.address.length / 2);
    const orig = kp.address[mid]!;
    const swap = orig === "A" ? "B" : "A";
    const tampered = kp.address.slice(0, mid) + swap + kp.address.slice(mid + 1);
    expect(isValidMoneroAddress(tampered)).toBe(false);
  });

  it("rejects non-base58 garbage", () => {
    expect(isValidMoneroAddress("not an address!!!")).toBe(false);
    expect(() => decodeMoneroAddress("")).toThrowError(/non-empty/);
  });

  it("distinguishes networks by prefix byte", () => {
    const spend = new Uint8Array(32).fill(1);
    const view = new Uint8Array(32).fill(2);
    const kp = keypairFromSecrets(spend, view, "testnet");
    const main = keypairFromSecrets(spend, view, "mainnet");
    expect(kp.address).not.toBe(main.address);
    expect(decodeMoneroAddress(kp.address).network).toBe("testnet");
    expect(decodeMoneroAddress(main.address).network).toBe("mainnet");
  });
});

// ----------------------------------------------------------------------------
//  Real signature — sign then verify, and tampered fails
// ----------------------------------------------------------------------------

describe("RealMoneroSigner — real Ed25519 signatures", () => {
  it("produces a signature that verifies against the spend pubkey", async () => {
    const signer = new RealMoneroSigner({
      spendSecret: new Uint8Array(32).fill(7),
      viewSecret: new Uint8Array(32).fill(11),
      network: "testnet",
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "500000000000",
      paymentId: "abc123",
    });
    const descriptor = canonicalTransferDescriptor({
      network: "testnet",
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "500000000000",
      paymentId: "abc123",
    });
    expect(signer.verify(res.signatureHex, descriptor)).toBe(true);
  });

  it("verify() FAILS on a tampered message", async () => {
    const signer = new RealMoneroSigner({
      spendSecret: new Uint8Array(32).fill(7),
      viewSecret: new Uint8Array(32).fill(11),
      network: "testnet",
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "500000000000",
      paymentId: "abc123",
    });
    const tamperedDescriptor = canonicalTransferDescriptor({
      network: "testnet",
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "999999999999", // amount changed
      paymentId: "abc123",
    });
    expect(signer.verify(res.signatureHex, tamperedDescriptor)).toBe(false);
  });

  it("exposes view key but never the spend secret on the signer surface", () => {
    const signer = new RealMoneroSigner({ network: "testnet" });
    expect(signer.viewPubHex).toMatch(/^[0-9a-f]{64}$/);
    expect(signer.viewSecretHex).toMatch(/^[0-9a-f]{64}$/);
    // No public spendSecret accessor — spendPubHex is fine (it's public).
    expect(signer.spendPubHex).toMatch(/^[0-9a-f]{64}$/);
    expect((signer as unknown as Record<string, unknown>)["spendSecretHex"]).toBeUndefined();
  });

  it("uses the pluggable submit hook when provided (offline-safe otherwise)", async () => {
    let captured: string | undefined;
    const signer = new RealMoneroSigner({
      spendSecret: new Uint8Array(32).fill(7),
      viewSecret: new Uint8Array(32).fill(11),
      network: "testnet",
      submit: async (input) => {
        captured = input.signatureHex;
        return { txHash: "TXHASH_MONERO_123", explorerUrl: "https://x/tx/abc" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1",
    });
    expect(captured).toBe(res.signatureHex);
    expect(res.txHash).toBe("TXHASH_MONERO_123");
  });
});

// ----------------------------------------------------------------------------
//  monero: URI parsing
// ----------------------------------------------------------------------------

describe("parseMoneroUri / buildMoneroUri", () => {
  it("parses a full monero: URI", () => {
    const uri = `monero:${RECIPIENT}?tx_amount=0.5&tx_payment_id=pid123&tx_description=Coffee&recipient_name=Bob`;
    const f = parseMoneroUri(uri);
    expect(f.recipient).toBe(RECIPIENT);
    expect(f.amount).toBe("0.5");
    expect(f.paymentId).toBe("pid123");
    expect(f.description).toBe("Coffee");
    expect(f.recipientName).toBe("Bob");
  });

  it("round-trips build → parse", () => {
    const uri = buildMoneroUri({ recipient: RECIPIENT, amount: "1.25", description: "Pay me" });
    const f = parseMoneroUri(uri);
    expect(f.amount).toBe("1.25");
    expect(f.description).toBe("Pay me");
  });

  it("rejects a URI without the monero: scheme", () => {
    expect(() => parseMoneroUri(`https://${RECIPIENT}`)).toThrowError(/monero:/);
  });

  it("rejects a URI with an invalid recipient address", () => {
    expect(() => parseMoneroUri("monero:NOTAVALIDADDR?tx_amount=1")).toThrowError(/valid address/);
  });
});

describe("xmrToAtomic", () => {
  it("converts whole + fractional XMR to piconero (12 dp)", () => {
    expect(xmrToAtomic("0.5")).toBe("500000000000");
    expect(xmrToAtomic("1")).toBe("1000000000000");
    expect(xmrToAtomic("0.000000000001")).toBe("1");
  });
  it("throws on invalid decimal", () => {
    expect(() => xmrToAtomic("abc")).toThrowError(/Invalid XMR/);
  });
});

// ----------------------------------------------------------------------------
//  WalletConnector
// ----------------------------------------------------------------------------

describe("MoneroConnector — capabilities", () => {
  it("reports walletProvider=monero with XMR @ 12 decimals", () => {
    const c = createMoneroConnector({ network: "testnet" });
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    const xmr = caps.supportedAssets.find((a) => a.symbol === "XMR");
    expect(xmr).toBeDefined();
    expect(xmr!.decimals).toBe(12);
    expect(caps.features?.privacyChain).toBe(true);
    expect(caps.features?.viewKeyModel).toBe(true);
    expect(caps.settlesOnChain).toBe(true);
  });

  it("getCapabilities is pure", () => {
    const c = createMoneroConnector();
    const a = c.getCapabilities();
    const b = c.getCapabilities();
    expect(a.walletProvider).toBe(b.walletProvider);
    expect(a.supportedAssets.length).toBe(b.supportedAssets.length);
  });
});

describe("MoneroConnector.createInstrument", () => {
  it("creates instrument with signer address + view key in metadata (NO spend key)", async () => {
    const signer = new RealMoneroSigner({ network: "testnet" });
    const c = new MoneroConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(signer.address);
    const md = inst.providerMetadata!;
    expect(md["viewPublicKeyHex"]).toBe(signer.viewPubHex);
    expect(md["viewSecretKeyHex"]).toBe(signer.viewSecretHex);
    // Spend secret must NEVER leak into instrument metadata.
    expect(JSON.stringify(md)).not.toContain(signer.spendPubHex.slice(0, 8) + "spend");
    expect(md["spendSecretKeyHex"]).toBeUndefined();
  });

  it("rejects empty userId", async () => {
    const c = createMoneroConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(/userId is required/);
  });

  it("is idempotent for the same userId", async () => {
    const c = createMoneroConnector();
    const a = await c.createInstrument({ userId: "alice" as UserId });
    const b = await c.createInstrument({ userId: "alice" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });
});

describe("MoneroConnector.getBalance", () => {
  it("returns XMR balance in atomic units from the signer", async () => {
    const signer = new RealMoneroSigner({
      network: "testnet",
      balanceReader: async () => 1_500_000_000_000n, // 1.5 XMR
    });
    const c = new MoneroConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1500000000000");
    expect(bal.money.currency).toBe("XMR");
    expect(bal.money.decimals).toBe(12);
  });

  it("throws on unknown instrumentId", async () => {
    const c = createMoneroConnector();
    await expect(c.getBalance("payment-instrument-monero-nope" as never)).rejects.toThrow(/not found/);
  });
});

describe("MoneroConnector.signAuthorization + settle", () => {
  it("happy path → real signature + SettlementResult.success", async () => {
    const signer = new RealMoneroSigner({
      spendSecret: new Uint8Array(32).fill(7),
      viewSecret: new Uint8Array(32).fill(11),
      network: "testnet",
    });
    const c = new MoneroConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildReq(),
      session: {} as Session,
    });
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/); // 64-byte ed25519 sig hex

    // The descriptor in `extra` lets anyone re-verify the signature offline.
    const descriptor = (signed.extra as Record<string, unknown>)["descriptor"] as string;
    expect(signer.verify(signed.signature, descriptor)).toBe(true);

    const settled = await c.settle(signed);
    expect(settled.success).toBe(true);
    expect(settled.transactionRef).toBe(signed.signature);
    expect(settled.network).toBe("monero-testnet");
    expect(settled.settledAmount?.currency).toBe("XMR");
  });

  it("rejects wrong protocol", async () => {
    const c = createMoneroConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildReq({ protocol: "x402-v1" as never }),
        session: {} as Session,
      })
    ).rejects.toThrow(/only supports monero-pay-v1/);
  });

  it("rejects an invalid recipient address at sign time", async () => {
    const c = createMoneroConnector();
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildReq({ recipient: "GARBAGE_NOT_MONERO" }),
        session: {} as Session,
      })
    ).rejects.toThrow(/valid Monero address/);
  });

  it("throws when signing against an unknown instrument id", async () => {
    const c = createMoneroConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "bogus" as never,
        request: buildReq(),
        session: {} as Session,
      })
    ).rejects.toThrow(/not found/);
  });

  it("settle returns failure when signature missing", async () => {
    const c = createMoneroConnector();
    const r = await c.settle({
      request: buildReq(),
      signer: "x",
      signature: "",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });

  it("settle uses real tx hash as transactionRef when broadcast happened", async () => {
    const signer = new RealMoneroSigner({
      spendSecret: new Uint8Array(32).fill(7),
      viewSecret: new Uint8Array(32).fill(11),
      network: "testnet",
      submit: async () => ({ txHash: "REALTXHASH", explorerUrl: "https://x/tx/REALTXHASH" }),
    });
    const c = new MoneroConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildReq(),
      session: {} as Session,
    });
    const settled = await c.settle(signed);
    expect(settled.transactionRef).toBe("REALTXHASH");
  });
});

// ----------------------------------------------------------------------------
//  helpers
// ----------------------------------------------------------------------------

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
