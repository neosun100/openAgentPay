/**
 * wallet-fuel unit tests — exercise the b256 address codec + derivation, keypair
 * derivation, real secp256k1 signing/verification (incl. tampered-fails), and
 * the FuelConnector lifecycle. All offline.
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
  FuelConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  FUEL_USDC_ASSET_ID,
} from "../src/connector.js";
import {
  RealFuelSigner,
  generateFuelKeypair,
  generateFuelMnemonic,
  keypairFromPrivateKey,
  keypairFromHex,
  keypairFromMnemonic,
  canonicalTransferDescriptor,
  isB256,
  toB256,
  fromB256,
  fuelAddressFromPublicKey,
  FUEL_BASE_ASSET_ID,
  FUEL_ETH_DECIMALS,
} from "../src/index.js";
import { secp256k1 } from "@noble/curves/secp256k1";

const PRIV = new Uint8Array(32).fill(9);
const RECIPIENT =
  "0x2c8e117bcf3a7088e646316243fb364fbd365d5b6c6f3a7a8b9c0d1e2f3a4b5c";

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000000", decimals: 9, currency: "ETH" },
    spent: { amountAtomic: "0", decimals: 9, currency: "ETH" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1500000000", decimals: 9, currency: "ETH" },
    recipient: RECIPIENT,
    asset: { symbol: "ETH", decimals: 9 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

describe("b256 codec + address derivation", () => {
  it("toB256/fromB256 round-trips a 32-byte buffer", () => {
    const data = new Uint8Array(32).fill(0xab);
    const b = toB256(data);
    expect(isB256(b)).toBe(true);
    expect(Array.from(fromB256(b))).toEqual(Array.from(data));
  });

  it("toB256 rejects non-32-byte input", () => {
    expect(() => toB256(new Uint8Array(31))).toThrow();
  });

  it("isB256 rejects malformed addresses", () => {
    expect(isB256("0x123")).toBe(false);
    expect(isB256("2c8e117bcf3a7088e646316243fb364fbd365d5b6c6f3a7a8b9c0d1e2f3a4b5c")).toBe(false);
    expect(isB256("0x" + "z".repeat(64))).toBe(false);
  });

  it("fromB256 rejects an invalid b256 string", () => {
    expect(() => fromB256("0xnope")).toThrow();
  });

  it("address = sha256(raw 64-byte pubkey) is a valid b256", () => {
    const uncompressed = secp256k1.getPublicKey(PRIV, false); // 65 bytes
    const addr = fuelAddressFromPublicKey(uncompressed);
    expect(isB256(addr)).toBe(true);
    // Manual recompute for cross-check.
    const kp = keypairFromPrivateKey(PRIV, "testnet");
    expect(kp.address).toBe(addr);
  });
});

describe("keypair derivation", () => {
  it("derives a deterministic b256 address from a fixed private key", () => {
    const kp = keypairFromPrivateKey(PRIV, "testnet");
    expect(isB256(kp.address)).toBe(true);
    expect(kp.network).toBe("testnet");
    expect(kp.publicKeyHex.length).toBe(128); // 64-byte raw pubkey (X||Y)
    // Reproducible.
    const kp2 = keypairFromHex(kp.privateKeyHex, "testnet");
    expect(kp2.address).toBe(kp.address);
  });

  it("generateFuelKeypair yields a fresh real b256 address", () => {
    const a = generateFuelKeypair("testnet");
    const b = generateFuelKeypair("testnet");
    expect(isB256(a.address)).toBe(true);
    expect(isB256(b.address)).toBe(true);
    expect(a.address).not.toBe(b.address); // overwhelmingly likely
  });

  it("derives deterministically from a BIP39 mnemonic", () => {
    const mnemonic = generateFuelMnemonic();
    const k1 = keypairFromMnemonic(mnemonic, "testnet");
    const k2 = keypairFromMnemonic(mnemonic, "testnet");
    expect(k1.address).toBe(k2.address);
    expect(isB256(k1.address)).toBe(true);
  });

  it("rejects a non-32-byte private key", () => {
    expect(() => keypairFromPrivateKey(new Uint8Array(31), "testnet")).toThrow();
  });
});

describe("RealFuelSigner", () => {
  it("produces a REAL secp256k1 signature that verify() accepts", async () => {
    const signer = new RealFuelSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amount: "1500000000",
      assetId: FUEL_BASE_ASSET_ID,
      reference: "REF_UNIT",
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amount: "1500000000",
      reference: "REF_UNIT",
    });
    expect(res.signature.length).toBe(128); // 64 bytes compact r||s
    expect(isB256(res.txid)).toBe(true); // txid is a b256 (sha256 of descriptor)
    expect(signer.verify(res.signature, descriptor)).toBe(true);
  });

  it("verify() FAILS on a tampered descriptor (signature is bound to intent)", async () => {
    const signer = new RealFuelSigner({ privateKey: PRIV, network: "testnet" });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amount: "1500000000",
      reference: "REF_UNIT",
    });
    const tamperedDescriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amount: "9999999999", // attacker bumps the amount
      assetId: FUEL_BASE_ASSET_ID,
      reference: "REF_UNIT",
    });
    expect(signer.verify(res.signature, tamperedDescriptor)).toBe(false);
  });

  it("verify() FAILS on a tampered signature", async () => {
    const signer = new RealFuelSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amount: "1500000000",
      assetId: FUEL_BASE_ASSET_ID,
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amount: "1500000000",
    });
    const flipped =
      res.signature.slice(0, -2) + (res.signature.endsWith("0") ? "1" : "0");
    expect(signer.verify(flipped, descriptor)).toBe(false);
  });

  it("routes broadcast through the pluggable submit hook when present", async () => {
    let called = false;
    const signer = new RealFuelSigner({
      privateKey: PRIV,
      network: "testnet",
      submit: async (i) => {
        called = true;
        expect(isB256(i.signer)).toBe(true);
        expect(i.assetId).toBe(FUEL_BASE_ASSET_ID);
        return { txid: "0x" + "ab".repeat(32), explorerUrl: "https://x/y" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amount: "1000000000",
    });
    expect(called).toBe(true);
    expect(res.txid).toBe("0x" + "ab".repeat(32));
  });

  it("reads balance via the optional balanceReader", async () => {
    const signer = new RealFuelSigner({
      privateKey: PRIV,
      network: "testnet",
      balanceReader: async () => 42_000_000_000n,
    });
    expect(await signer.getBalance()).toBe(42_000_000_000n);
  });
});

describe("FuelConnector", () => {
  const make = () =>
    new FuelConnector({
      signer: new RealFuelSigner({ privateKey: PRIV, network: "testnet" }),
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });

  it("reports fuel capabilities (ETH 9dp + USDC 6dp, fuel-pay-v1, b256)", () => {
    const caps = make().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets[0]?.symbol).toBe("ETH");
    expect(caps.supportedAssets[0]?.decimals).toBe(FUEL_ETH_DECIMALS);
    expect(caps.supportedAssets[1]?.symbol).toBe("USDC");
    expect(caps.supportedAssets[1]?.decimals).toBe(6);
    expect(caps.features?.["addressFormat"]).toBe("b256");
    expect(caps.settlesOnChain).toBe(true);
  });

  it("all supported asset decimals are <= 24", () => {
    for (const a of make().getCapabilities().supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
  });

  it("createInstrument is idempotent and yields a b256 publicHandle", async () => {
    const c = make();
    const userId = "u-idem" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(isB256(a.publicHandle)).toBe(true);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("createInstrument rejects an empty userId", async () => {
    await expect(
      make().createInstrument({ userId: "" as UserId })
    ).rejects.toThrow();
  });

  it("getBalance throws on an unknown instrument id", async () => {
    await expect(
      make().getBalance("payment-instrument-fuel-nope" as InstrumentId)
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
    expect(isB256(signed.signer)).toBe(true);
    expect(signed.signature.length).toBe(128);
    // Recompute the descriptor the connector signed and verify the signature.
    const signer = new RealFuelSigner({ privateKey: PRIV, network: "testnet" });
    const descriptor = c.descriptorFor({
      recipient: request.recipient,
      amount: request.amount.amountAtomic,
      assetSymbol: request.asset.symbol,
      reference: request.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("signAuthorization routes USDC to the USDC AssetId", async () => {
    const c = make();
    const userId = "u-usdc" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest({
        amount: { amountAtomic: "5000000", decimals: 6, currency: "USDC" },
        asset: { symbol: "USDC", decimals: 6 },
      }),
      session: buildSession(userId),
    });
    expect((signed.extra as Record<string, unknown>)["assetId"]).toBe(
      FUEL_USDC_ASSET_ID
    );
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
        instrumentId: "payment-instrument-fuel-ghost" as InstrumentId,
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
    expect(result.network).toBe("fuel-testnet");
    expect(typeof result.transactionRef).toBe("string");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
