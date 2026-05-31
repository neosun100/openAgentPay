/**
 * wallet-stacks unit tests — exercise the c32check codec, keypair derivation,
 * real secp256k1 signing/verification (incl. tampered-fails), and the
 * StacksConnector lifecycle. All offline.
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
  StacksConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  RealStacksSigner,
  generateStacksKeypair,
  generateStacksMnemonic,
  keypairFromPrivateKey,
  keypairFromHex,
  keypairFromMnemonic,
  canonicalTransferDescriptor,
  c32address,
  c32addressDecode,
  c32encode,
  c32decode,
  c32checkEncode,
  c32checkDecode,
  hash160,
  addressPrefixFor,
  STACKS_VERSION,
} from "../src/index.js";

const PRIV = new Uint8Array(32).fill(7);

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "STX" },
    spent: { amountAtomic: "0", decimals: 6, currency: "STX" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1500000", decimals: 6, currency: "STX" },
    recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
    asset: { symbol: "STX", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

describe("c32check codec", () => {
  it("c32encode/c32decode round-trips arbitrary bytes", () => {
    const samples = [
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array(20).fill(0xab),
      new Uint8Array([0xff, 0x00, 0x10, 0x99]),
      hash160(new Uint8Array([9, 9, 9])),
    ];
    for (const s of samples) {
      const round = c32decode(c32encode(s));
      expect(Array.from(round)).toEqual(Array.from(s));
    }
  });

  it("c32encode/c32decode round-trips buffers with a leading zero byte", () => {
    const s = new Uint8Array([0x00, 0x12, 0x34, 0x56]);
    const round = c32decode(c32encode(s));
    expect(Array.from(round)).toEqual(Array.from(s));
  });

  it("c32checkEncode/c32checkDecode round-trips with version + checksum", () => {
    const data = hash160(new Uint8Array([4, 2]));
    const enc = c32checkEncode(STACKS_VERSION.testnet, data);
    const dec = c32checkDecode(enc);
    expect(dec.version).toBe(STACKS_VERSION.testnet);
    expect(Array.from(dec.data)).toEqual(Array.from(data));
  });

  it("c32checkDecode rejects a tampered checksum", () => {
    const data = hash160(new Uint8Array([5, 5, 5]));
    const enc = c32checkEncode(STACKS_VERSION.testnet, data);
    // Flip a character in the body to corrupt the checksum.
    const lastChar = enc[enc.length - 1] === "0" ? "1" : "0";
    const tampered = enc.slice(0, -1) + lastChar;
    expect(() => c32checkDecode(tampered)).toThrow();
  });

  it("c32address produces a testnet 'ST' address that decodes back", () => {
    const h160 = hash160(new Uint8Array([1, 1, 1, 1]));
    const addr = c32address(STACKS_VERSION.testnet, h160);
    expect(addr.startsWith("ST")).toBe(true);
    const dec = c32addressDecode(addr);
    expect(dec.version).toBe(STACKS_VERSION.testnet);
    expect(Array.from(dec.hash160)).toEqual(Array.from(h160));
  });

  it("mainnet addresses begin with 'SP'", () => {
    expect(addressPrefixFor("mainnet")).toBe("SP");
    expect(addressPrefixFor("testnet")).toBe("ST");
    const h160 = hash160(new Uint8Array([2, 2, 2, 2]));
    const addr = c32address(STACKS_VERSION.mainnet, h160);
    expect(addr.startsWith("SP")).toBe(true);
  });
});

describe("keypair derivation", () => {
  it("derives a deterministic 'ST' testnet address from a fixed private key", () => {
    const kp = keypairFromPrivateKey(PRIV, "testnet");
    expect(kp.address.startsWith("ST")).toBe(true);
    expect(kp.network).toBe("testnet");
    expect(kp.publicKeyHex.length).toBe(66); // 33 bytes compressed
    // Reproducible.
    const kp2 = keypairFromHex(kp.privateKeyHex, "testnet");
    expect(kp2.address).toBe(kp.address);
  });

  it("generateStacksKeypair yields a fresh real 'ST' address", () => {
    const a = generateStacksKeypair("testnet");
    const b = generateStacksKeypair("testnet");
    expect(a.address.startsWith("ST")).toBe(true);
    expect(b.address.startsWith("ST")).toBe(true);
    expect(a.address).not.toBe(b.address); // overwhelmingly likely
  });

  it("derives deterministically from a BIP39 mnemonic", () => {
    const mnemonic = generateStacksMnemonic();
    const k1 = keypairFromMnemonic(mnemonic, "testnet");
    const k2 = keypairFromMnemonic(mnemonic, "testnet");
    expect(k1.address).toBe(k2.address);
    expect(k1.address.startsWith("ST")).toBe(true);
  });

  it("rejects a non-32-byte private key", () => {
    expect(() => keypairFromPrivateKey(new Uint8Array(31), "testnet")).toThrow();
  });
});

describe("RealStacksSigner", () => {
  it("produces a REAL secp256k1 signature that verify() accepts", async () => {
    const signer = new RealStacksSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountMicroStx: "1500000",
      reference: "REF_UNIT",
    });
    const res = await signer.signAndSubmit({
      recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountMicroStx: "1500000",
      reference: "REF_UNIT",
    });
    expect(res.signature.length).toBe(128); // 64 bytes compact r||s
    expect(signer.verify(res.signature, descriptor)).toBe(true);
  });

  it("verify() FAILS on a tampered descriptor (signature is bound to intent)", async () => {
    const signer = new RealStacksSigner({ privateKey: PRIV, network: "testnet" });
    const res = await signer.signAndSubmit({
      recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountMicroStx: "1500000",
      reference: "REF_UNIT",
    });
    const tamperedDescriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountMicroStx: "9999999", // attacker bumps the amount
      reference: "REF_UNIT",
    });
    expect(signer.verify(res.signature, tamperedDescriptor)).toBe(false);
  });

  it("verify() FAILS on a tampered signature", async () => {
    const signer = new RealStacksSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountMicroStx: "1500000",
    });
    const res = await signer.signAndSubmit({
      recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountMicroStx: "1500000",
    });
    const flipped =
      res.signature.slice(0, -2) + (res.signature.endsWith("0") ? "1" : "0");
    expect(signer.verify(flipped, descriptor)).toBe(false);
  });

  it("routes broadcast through the pluggable submit hook when present", async () => {
    let called = false;
    const signer = new RealStacksSigner({
      privateKey: PRIV,
      network: "testnet",
      submit: async (i) => {
        called = true;
        expect(i.signer.startsWith("ST")).toBe(true);
        return { txid: "deadbeefdeadbeef", explorerUrl: "https://x/y" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountMicroStx: "1000000",
    });
    expect(called).toBe(true);
    expect(res.txid).toBe("deadbeefdeadbeef");
  });

  it("reads balance via the optional balanceReader (microSTX)", async () => {
    const signer = new RealStacksSigner({
      privateKey: PRIV,
      network: "testnet",
      balanceReader: async () => 42_000_000n,
    });
    expect(await signer.getBalance()).toBe(42_000_000n);
  });
});

describe("StacksConnector", () => {
  const make = () =>
    new StacksConnector({
      signer: new RealStacksSigner({ privateKey: PRIV, network: "testnet" }),
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });

  it("reports stacks capabilities (STX 6dp, stacks-pay-v1, c32check)", () => {
    const caps = make().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets[0]?.symbol).toBe("STX");
    expect(caps.supportedAssets[0]?.decimals).toBe(6);
    expect(caps.features?.["addressFormat"]).toBe("c32check");
    expect(caps.settlesOnChain).toBe(true);
  });

  it("createInstrument is idempotent and yields an 'ST' publicHandle", async () => {
    const c = make();
    const userId = "u-idem" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle.startsWith("ST")).toBe(true);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("createInstrument rejects an empty userId", async () => {
    await expect(
      make().createInstrument({ userId: "" as UserId })
    ).rejects.toThrow();
  });

  it("getBalance throws on an unknown instrument id", async () => {
    await expect(
      make().getBalance("payment-instrument-stacks-nope" as InstrumentId)
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
    expect(signed.signer.startsWith("ST")).toBe(true);
    expect(signed.signature.length).toBe(128);
    // Recompute the descriptor the connector signed and verify the signature.
    const signer = new RealStacksSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = c.descriptorFor({
      recipient: request.recipient,
      amountMicroStx: request.amount.amountAtomic,
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
        instrumentId: "payment-instrument-stacks-ghost" as InstrumentId,
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
    expect(result.network).toBe("stacks-testnet");
    expect(typeof result.transactionRef).toBe("string");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
