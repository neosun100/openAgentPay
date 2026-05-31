/**
 * wallet-starknet unit tests — exercise the felt252 address codec, keypair
 * derivation, real secp256k1 signing/verification (incl. tampered-fails), and
 * the StarknetConnector lifecycle. All offline.
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
  StarknetConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  RealStarknetSigner,
  generateStarknetKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  canonicalTransferDescriptor,
  feltAddressFromPublicKey,
  normalizeFelt,
  isFelt,
  explorerBase,
  STARK_PRIME,
} from "../src/index.js";

const PRIV = new Uint8Array(32).fill(9);
const RECIPIENT =
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000000000000", decimals: 18, currency: "ETH" },
    spent: { amountAtomic: "0", decimals: 18, currency: "ETH" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
    recipient: RECIPIENT,
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

describe("felt252 address codec", () => {
  it("normalizeFelt canonicalizes 0x-prefixed hex and strips leading zeros", () => {
    expect(normalizeFelt("0x00ab")).toBe("0xab");
    expect(normalizeFelt("AB")).toBe("0xab");
    expect(normalizeFelt("0x0")).toBe("0x0");
  });

  it("normalizeFelt rejects non-hex and out-of-field values", () => {
    expect(() => normalizeFelt("0xzz")).toThrow();
    expect(() => normalizeFelt("")).toThrow();
    // 64 'f's = 2^256-1, far above the STARK prime → rejected.
    expect(() => normalizeFelt("0x" + "f".repeat(64))).toThrow();
  });

  it("isFelt accepts valid felts and rejects garbage", () => {
    expect(isFelt(RECIPIENT)).toBe(true);
    expect(isFelt("0x" + "f".repeat(64))).toBe(false);
    expect(isFelt("not-hex")).toBe(false);
  });

  it("feltAddressFromPublicKey yields a valid in-field felt252 (62 hex max)", () => {
    const kp = keypairFromPrivateKey(PRIV, "sepolia");
    const addr = kp.address;
    expect(addr.startsWith("0x")).toBe(true);
    // 31 bytes = 248 bits → at most 62 hex chars after 0x.
    expect(addr.length - 2).toBeLessThanOrEqual(62);
    // strictly inside the field
    expect(BigInt(addr) < STARK_PRIME).toBe(true);
  });

  it("explorerBase points at sepolia.starkscan for testnet", () => {
    expect(explorerBase("sepolia")).toBe("https://sepolia.starkscan.co");
    expect(explorerBase("mainnet")).toBe("https://starkscan.co");
  });
});

describe("keypair derivation", () => {
  it("derives a deterministic felt252 address from a fixed private key", () => {
    const kp = keypairFromPrivateKey(PRIV, "sepolia");
    expect(kp.address.startsWith("0x")).toBe(true);
    expect(kp.network).toBe("sepolia");
    expect(kp.publicKeyHex.length).toBe(66); // 33 bytes compressed
    // Reproducible.
    const kp2 = keypairFromHex(kp.privateKeyHex, "sepolia");
    expect(kp2.address).toBe(kp.address);
    // Matches direct derivation from the pubkey.
    const fromPub = feltAddressFromPublicKey(
      Uint8Array.from(
        kp.publicKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
      )
    );
    expect(fromPub).toBe(kp.address);
  });

  it("generateStarknetKeypair yields a fresh real felt252 address", () => {
    const a = generateStarknetKeypair("sepolia");
    const b = generateStarknetKeypair("sepolia");
    expect(isFelt(a.address)).toBe(true);
    expect(isFelt(b.address)).toBe(true);
    expect(a.address).not.toBe(b.address); // overwhelmingly likely
  });

  it("rejects a non-32-byte private key", () => {
    expect(() => keypairFromPrivateKey(new Uint8Array(31), "sepolia")).toThrow();
  });
});

describe("RealStarknetSigner", () => {
  it("produces a REAL secp256k1 signature that verify() accepts", async () => {
    const signer = new RealStarknetSigner({ privateKey: PRIV, network: "sepolia" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "1000000",
      asset: "USDC",
      reference: "REF_UNIT",
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000000",
      asset: "USDC",
      reference: "REF_UNIT",
    });
    expect(res.signature.length).toBe(128); // 64 bytes compact r||s
    expect(res.txHash.startsWith("0x")).toBe(true);
    expect(signer.verify(res.signature, descriptor)).toBe(true);
  });

  it("verify() FAILS on a tampered descriptor (signature is bound to intent)", async () => {
    const signer = new RealStarknetSigner({ privateKey: PRIV, network: "sepolia" });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000000",
      asset: "USDC",
      reference: "REF_UNIT",
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "9999999", // attacker bumps the amount
      asset: "USDC",
      reference: "REF_UNIT",
    });
    expect(signer.verify(res.signature, tampered)).toBe(false);
  });

  it("verify() FAILS on a tampered signature", async () => {
    const signer = new RealStarknetSigner({ privateKey: PRIV, network: "sepolia" });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "1000000",
      asset: "USDC",
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000000",
      asset: "USDC",
    });
    const flipped =
      res.signature.slice(0, -2) + (res.signature.endsWith("0") ? "1" : "0");
    expect(signer.verify(flipped, descriptor)).toBe(false);
  });

  it("routes broadcast through the pluggable submit hook when present", async () => {
    let called = false;
    const signer = new RealStarknetSigner({
      privateKey: PRIV,
      network: "sepolia",
      submit: async (i) => {
        called = true;
        expect(i.signer.startsWith("0x")).toBe(true);
        expect(i.asset).toBe("ETH");
        return { txHash: "0xdeadbeef", explorerUrl: "https://x/y" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000000000000000000",
      asset: "ETH",
    });
    expect(called).toBe(true);
    expect(res.txHash).toBe("0xdeadbeef");
  });

  it("reads balance via the optional balanceReader (smallest unit)", async () => {
    const signer = new RealStarknetSigner({
      privateKey: PRIV,
      network: "sepolia",
      balanceReader: async ({ asset }) => (asset === "ETH" ? 42n : 0n),
    });
    expect(await signer.getBalance("ETH")).toBe(42n);
  });
});

describe("StarknetConnector", () => {
  const make = () =>
    new StarknetConnector({
      signer: new RealStarknetSigner({ privateKey: PRIV, network: "sepolia" }),
      instrumentStore: new MemoryInstrumentStore(),
      network: "sepolia",
    });

  it("reports starknet capabilities (ETH 18dp + USDC 6dp, starknet-pay-v1, felt252)", () => {
    const caps = make().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    const symbols = caps.supportedAssets.map((a) => a.symbol);
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("USDC");
    // all decimals <= 24
    for (const a of caps.supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
    expect(caps.features?.["addressFormat"]).toBe("felt252");
    expect(caps.settlesOnChain).toBe(true);
  });

  it("createInstrument is idempotent and yields a felt252 publicHandle", async () => {
    const c = make();
    const userId = "u-idem" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(isFelt(a.publicHandle)).toBe(true);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("createInstrument rejects an empty userId", async () => {
    await expect(
      make().createInstrument({ userId: "" as UserId })
    ).rejects.toThrow();
  });

  it("getBalance throws on an unknown instrument id", async () => {
    await expect(
      make().getBalance("payment-instrument-starknet-nope" as InstrumentId)
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
    expect(signed.signer.startsWith("0x")).toBe(true);
    expect(signed.signature.length).toBe(128);
    const signer = new RealStarknetSigner({ privateKey: PRIV, network: "sepolia" });
    const descriptor = c.descriptorFor({
      recipient: request.recipient,
      amountAtomic: request.amount.amountAtomic,
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
        instrumentId: "payment-instrument-starknet-ghost" as InstrumentId,
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
    expect(result.network).toBe("starknet-sepolia");
    expect(typeof result.transactionRef).toBe("string");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
