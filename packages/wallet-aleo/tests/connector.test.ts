/**
 * wallet-aleo unit tests — exercise the bech32m "aleo1…" codec, keypair
 * derivation, real ed25519 signing/verification (incl. tampered-fails), and
 * the AleoConnector lifecycle. All offline.
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
  AleoConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  RealAleoSigner,
  generateAleoKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  canonicalTransferDescriptor,
  aleoAddressEncode,
  aleoAddressDecode,
  addressProgram,
  ALEO_HRP,
  ALEO_ADDR_BYTES,
} from "../src/index.js";

const PRIV = new Uint8Array(32).fill(7);
const RECIPIENT =
  "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "ALEO" },
    spent: { amountAtomic: "0", decimals: 6, currency: "ALEO" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1500000", decimals: 6, currency: "ALEO" },
    recipient: RECIPIENT,
    asset: { symbol: "ALEO", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

describe("bech32m aleo address codec", () => {
  it("aleoAddressEncode/Decode round-trips a 20-byte program", () => {
    const program = addressProgram(new Uint8Array(32).fill(9));
    expect(program.length).toBe(ALEO_ADDR_BYTES);
    const addr = aleoAddressEncode(program);
    expect(addr.startsWith("aleo1")).toBe(true);
    const dec = aleoAddressDecode(addr);
    expect(dec.hrp).toBe(ALEO_HRP);
    expect(Array.from(dec.program)).toEqual(Array.from(program));
  });

  it("aleoAddressEncode rejects a wrong-length program", () => {
    expect(() => aleoAddressEncode(new Uint8Array(19))).toThrow();
    expect(() => aleoAddressEncode(new Uint8Array(21))).toThrow();
  });

  it("aleoAddressDecode rejects a tampered checksum", () => {
    const program = addressProgram(new Uint8Array(32).fill(5));
    const addr = aleoAddressEncode(program);
    // Flip the final char (before checksum tail) to corrupt the bech32m sum.
    const lastChar = addr[addr.length - 1] === "p" ? "q" : "p";
    const tampered = addr.slice(0, -1) + lastChar;
    expect(() => aleoAddressDecode(tampered)).toThrow();
  });

  it("aleoAddressDecode rejects a wrong HRP", () => {
    // A valid bech32m string with a different HRP must be rejected.
    const program = addressProgram(new Uint8Array(32).fill(3));
    const addr = aleoAddressEncode(program).replace(/^aleo/, "");
    expect(() => aleoAddressDecode("notaleo1" + addr.slice(1))).toThrow();
  });
});

describe("keypair derivation", () => {
  it("derives a deterministic 'aleo1' address from a fixed private key", () => {
    const kp = keypairFromPrivateKey(PRIV, "testnet");
    expect(kp.address.startsWith("aleo1")).toBe(true);
    expect(kp.network).toBe("testnet");
    expect(kp.publicKeyHex.length).toBe(64); // 32 bytes ed25519 pubkey
    // Reproducible.
    const kp2 = keypairFromHex(kp.privateKeyHex, "testnet");
    expect(kp2.address).toBe(kp.address);
  });

  it("generateAleoKeypair yields a fresh real 'aleo1' address", () => {
    const a = generateAleoKeypair("testnet");
    const b = generateAleoKeypair("testnet");
    expect(a.address.startsWith("aleo1")).toBe(true);
    expect(b.address.startsWith("aleo1")).toBe(true);
    expect(a.address).not.toBe(b.address); // overwhelmingly likely
  });

  it("rejects a non-32-byte private key", () => {
    expect(() => keypairFromPrivateKey(new Uint8Array(31), "testnet")).toThrow();
  });
});

describe("RealAleoSigner", () => {
  it("produces a REAL ed25519 signature that verify() accepts", async () => {
    const signer = new RealAleoSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountMicrocredits: "1500000",
      asset: "ALEO",
      reference: "REF_UNIT",
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountMicrocredits: "1500000",
      asset: "ALEO",
      reference: "REF_UNIT",
    });
    expect(res.signature.length).toBe(128); // 64-byte ed25519 sig
    expect(signer.verify(res.signature, descriptor)).toBe(true);
  });

  it("verify() FAILS on a tampered descriptor (signature is bound to intent)", async () => {
    const signer = new RealAleoSigner({ privateKey: PRIV, network: "testnet" });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountMicrocredits: "1500000",
      asset: "ALEO",
      reference: "REF_UNIT",
    });
    const tamperedDescriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountMicrocredits: "9999999", // attacker bumps the amount
      asset: "ALEO",
      reference: "REF_UNIT",
    });
    expect(signer.verify(res.signature, tamperedDescriptor)).toBe(false);
  });

  it("verify() FAILS on a tampered signature", async () => {
    const signer = new RealAleoSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountMicrocredits: "1500000",
      asset: "ALEO",
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountMicrocredits: "1500000",
      asset: "ALEO",
    });
    const flipped =
      res.signature.slice(0, -2) + (res.signature.endsWith("0") ? "1" : "0");
    expect(signer.verify(flipped, descriptor)).toBe(false);
  });

  it("routes broadcast through the pluggable submit hook when present", async () => {
    let called = false;
    const signer = new RealAleoSigner({
      privateKey: PRIV,
      network: "testnet",
      submit: async (i) => {
        called = true;
        expect(i.signer.startsWith("aleo1")).toBe(true);
        return { txid: "at1deadbeefdeadbeef", explorerUrl: "https://x/y" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountMicrocredits: "1000000",
      asset: "ALEO",
    });
    expect(called).toBe(true);
    expect(res.txid).toBe("at1deadbeefdeadbeef");
  });

  it("reads balance via the optional balanceReader (microcredits)", async () => {
    const signer = new RealAleoSigner({
      privateKey: PRIV,
      network: "testnet",
      balanceReader: async () => 42_000_000n,
    });
    expect(await signer.getBalance()).toBe(42_000_000n);
  });

  it("getBalance returns 0 offline (no balanceReader wired)", async () => {
    const signer = new RealAleoSigner({ privateKey: PRIV, network: "testnet" });
    expect(await signer.getBalance()).toBe(0n);
  });
});

describe("AleoConnector", () => {
  const make = () =>
    new AleoConnector({
      signer: new RealAleoSigner({ privateKey: PRIV, network: "testnet" }),
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });

  it("reports aleo capabilities (ALEO 6dp, aleo-pay-v1, bech32m)", () => {
    const caps = make().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets[0]?.symbol).toBe("ALEO");
    expect(caps.supportedAssets[0]?.decimals).toBe(6);
    expect(caps.features?.["addressFormat"]).toBe("bech32m");
    expect(caps.settlesOnChain).toBe(true);
    // All asset decimals <= 24.
    for (const a of caps.supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
  });

  it("createInstrument is idempotent and yields an 'aleo1' publicHandle", async () => {
    const c = make();
    const userId = "u-idem" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle.startsWith("aleo1")).toBe(true);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("createInstrument rejects an empty userId", async () => {
    await expect(
      make().createInstrument({ userId: "" as UserId })
    ).rejects.toThrow();
  });

  it("getBalance throws on an unknown instrument id", async () => {
    await expect(
      make().getBalance("payment-instrument-aleo-nope" as InstrumentId)
    ).rejects.toThrow();
  });

  it("signAuthorization returns a verifiable signature bound to the request", async () => {
    const c = make();
    const userId = "u-sign" as UserId;
    const inst = await c.createInstrument({ userId });
    const request = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request,
      session: buildSession(userId),
    });
    expect(signed.signer.startsWith("aleo1")).toBe(true);
    expect(signed.signature.length).toBe(128);
    // Recompute the descriptor the connector signed and verify the signature.
    const signer = new RealAleoSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = c.descriptorFor({
      recipient: request.recipient,
      amountMicrocredits: request.amount.amountAtomic,
      asset: request.asset.symbol,
      reference: request.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("signAuthorization rejects a wrong protocol", async () => {
    const c = make();
    const userId = "u-proto" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-v9" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow();
  });

  it("signAuthorization throws on an unknown instrument id", async () => {
    const c = make();
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-aleo-ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession("ghost" as UserId),
      })
    ).rejects.toThrow();
  });

  it("settle adapts a signed authorization into a SettlementResult", async () => {
    const c = make();
    const userId = "u-settle" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("aleo-testnet");
    expect(typeof result.transactionRef).toBe("string");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
