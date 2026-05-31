/**
 * CardanoConnector + RealCardanoSigner unit tests.
 *
 * Covers: capabilities, createInstrument (incl. empty-userId rejection +
 * idempotency), getBalance (incl. unknown-instrument error), signAuthorization
 * (incl. real Ed25519 verify + tampered-message rejection + wrong-protocol
 * rejection), settle, keygen (address format), and address codec round-trip.
 *
 * Fully offline — no network, no signups.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type {
  InstrumentId,
  PaymentRequest,
  Session,
  SessionId,
  UserId,
  ProtocolId,
} from "@openagentpay/core";
import {
  CardanoConnector,
  DemoCardanoSigner,
  MemoryInstrumentStore,
  RealCardanoSigner,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  generateCardanoKeypair,
  keypairFromSeed,
  keypairFromHex,
  enterpriseAddress,
  decodeEnterpriseAddress,
  paymentKeyHash,
  canonicalTransferDescriptor,
  ENTERPRISE_TESTNET_HEADER,
} from "../src/index.js";

const TEST_SEED = new Uint8Array(32).fill(7);

function buildConnector(opts: { initialBalanceAtomic?: string } = {}) {
  const signer = new RealCardanoSigner({ seed: TEST_SEED, network: "testnet" });
  const store = new MemoryInstrumentStore();
  const connector = new CardanoConnector({
    signer,
    instrumentStore: store,
    network: "testnet",
    ...(opts.initialBalanceAtomic !== undefined
      ? {
          // swap in a balance-aware signer
        }
      : {}),
  });
  return { connector, signer, store };
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "ADA" },
    spent: { amountAtomic: "0", decimals: 6, currency: "ADA" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1500000", decimals: 6, currency: "ADA" },
    recipient:
      "addr_test1vqg9ywrnxm0z4j0qf3vqj8d3p7x0kqg7h6w7n6m5l4k3j2vqe5xyz",
    asset: { symbol: "ADA", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

// ============================================================================
//  Keypair / address generation
// ============================================================================

describe("keygen + address format", () => {
  it("generateCardanoKeypair yields an addr_test1… testnet address", () => {
    const kp = generateCardanoKeypair("testnet");
    expect(kp.address.startsWith("addr_test1")).toBe(true);
    expect(kp.network).toBe("testnet");
    expect(kp.publicKeyHex.length).toBe(64); // 32 bytes hex
    expect(kp.paymentKeyHashHex.length).toBe(56); // 28 bytes hex (blake2b-224)
  });

  it("mainnet keypair yields an addr1… address (no _test)", () => {
    const kp = generateCardanoKeypair("mainnet");
    expect(kp.address.startsWith("addr1")).toBe(true);
    expect(kp.address.startsWith("addr_test1")).toBe(false);
  });

  it("keypairFromSeed is deterministic for a fixed seed", () => {
    const a = keypairFromSeed(TEST_SEED, "testnet");
    const b = keypairFromSeed(TEST_SEED, "testnet");
    expect(a.address).toBe(b.address);
    expect(a.address.startsWith("addr_test1")).toBe(true);
  });

  it("keypairFromHex round-trips the seed", () => {
    const kp = keypairFromSeed(TEST_SEED, "testnet");
    const loaded = keypairFromHex(kp.secretSeedHex, "testnet");
    expect(loaded.address).toBe(kp.address);
    expect(loaded.publicKeyHex).toBe(kp.publicKeyHex);
  });

  it("rejects a wrong-length seed", () => {
    expect(() => keypairFromSeed(new Uint8Array(31), "testnet")).toThrow();
  });

  it("enterpriseAddress + decodeEnterpriseAddress round-trip the key hash", () => {
    const kp = keypairFromSeed(TEST_SEED, "testnet");
    const keyHash = paymentKeyHash(
      Uint8Array.from(
        kp.publicKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
      )
    );
    const addr = enterpriseAddress(keyHash, "testnet");
    expect(addr).toBe(kp.address);
    const decoded = decodeEnterpriseAddress(addr);
    expect(decoded.network).toBe("testnet");
    expect(decoded.header).toBe(ENTERPRISE_TESTNET_HEADER);
    expect(decoded.keyHashHex).toBe(kp.paymentKeyHashHex);
  });
});

// ============================================================================
//  Capabilities
// ============================================================================

describe("getCapabilities()", () => {
  it("reports the cardano provider + cardano-pay-v1 protocol", () => {
    const { connector } = buildConnector();
    const caps = connector.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.settlesOnChain).toBe(true);
  });

  it("lists ADA + USDM assets at 6 decimals", () => {
    const { connector } = buildConnector();
    const syms = connector.getCapabilities().supportedAssets.map((a) => a.symbol);
    expect(syms).toContain("ADA");
    expect(syms).toContain("USDM");
    for (const a of connector.getCapabilities().supportedAssets) {
      expect(a.decimals).toBe(6);
    }
  });
});

// ============================================================================
//  createInstrument
// ============================================================================

describe("createInstrument()", () => {
  it("binds the signer address as publicHandle (addr_test1…)", async () => {
    const { connector, signer } = buildConnector();
    const inst = await connector.createInstrument({
      userId: "u1" as UserId,
    });
    expect(inst.publicHandle).toBe(signer.address);
    expect(inst.publicHandle.startsWith("addr_test1")).toBe(true);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("rejects an empty userId", async () => {
    const { connector } = buildConnector();
    await expect(
      connector.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("is idempotent per userId", async () => {
    const { connector } = buildConnector();
    const a = await connector.createInstrument({ userId: "same" as UserId });
    const b = await connector.createInstrument({ userId: "same" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });
});

// ============================================================================
//  getBalance
// ============================================================================

describe("getBalance()", () => {
  it("returns a 6-decimal ADA balance for a known instrument", async () => {
    const signer = new DemoCardanoSigner({
      address: "addr_test1vdemo",
      initialBalanceAtomic: "4200000",
    });
    const store = new MemoryInstrumentStore();
    const connector = new CardanoConnector({
      signer,
      instrumentStore: store,
      network: "testnet",
    });
    const inst = await connector.createInstrument({ userId: "bal" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("4200000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("ADA");
    expect(BigInt(bal.money.amountAtomic) >= 0n).toBe(true);
  });

  it("throws on an unknown instrumentId", async () => {
    const { connector } = buildConnector();
    await expect(
      connector.getBalance("payment-instrument-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ============================================================================
//  signAuthorization — real Ed25519 + verify + tamper detection
// ============================================================================

describe("signAuthorization()", () => {
  it("produces a real Ed25519 signature that verifies", async () => {
    const { connector, signer } = buildConnector();
    const inst = await connector.createInstrument({ userId: "s1" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("s1" as UserId),
    });
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature.length).toBeGreaterThan(0);
    // 64-byte Ed25519 signature → 128 hex chars
    expect(signed.signature.length).toBe(128);
    const descriptor = (signed.extra as Record<string, unknown>)[
      "descriptor"
    ] as string;
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("a tampered message fails verification", async () => {
    const { connector, signer } = buildConnector();
    const inst = await connector.createInstrument({ userId: "s2" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("s2" as UserId),
    });
    const descriptor = (signed.extra as Record<string, unknown>)[
      "descriptor"
    ] as string;
    const tampered = descriptor.replace("amount=1500000", "amount=999999999");
    expect(signer.verify(signed.signature, tampered)).toBe(false);
  });

  it("echoes the request fields", async () => {
    const { connector } = buildConnector();
    const inst = await connector.createInstrument({ userId: "s3" as UserId });
    const req = buildRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession("s3" as UserId),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    expect(signed.request.amount.amountAtomic).toBe(req.amount.amountAtomic);
  });

  it("rejects a non-cardano protocol", async () => {
    const { connector } = buildConnector();
    const inst = await connector.createInstrument({ userId: "s4" as UserId });
    await expect(
      connector.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "x402-v1" as ProtocolId }),
        session: buildSession("s4" as UserId),
      })
    ).rejects.toThrow(/cardano-pay-v1/);
  });

  it("rejects an unknown instrumentId", async () => {
    const { connector } = buildConnector();
    await expect(
      connector.signAuthorization({
        instrumentId: "bogus" as InstrumentId,
        request: buildRequest(),
        session: buildSession("s5" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("signs a USDM-denominated request (asset unit threaded through)", async () => {
    const { connector, signer } = buildConnector();
    const inst = await connector.createInstrument({ userId: "s6" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest({
        amount: { amountAtomic: "2000000", decimals: 6, currency: "USDM" },
        asset: { symbol: "USDM", decimals: 6 },
      }),
      session: buildSession("s6" as UserId),
    });
    const descriptor = (signed.extra as Record<string, unknown>)[
      "descriptor"
    ] as string;
    expect(descriptor).toContain("asset=");
    expect(descriptor).not.toContain("asset=lovelace");
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });
});

// ============================================================================
//  settle
// ============================================================================

describe("settle()", () => {
  it("returns a successful offline receipt with a stable transactionRef", async () => {
    const { connector } = buildConnector();
    const inst = await connector.createInstrument({ userId: "set1" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("set1" as UserId),
    });
    const result = await connector.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("cardano-testnet");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((result.transactionRef as string).length).toBeGreaterThan(0);
    expect((result.transactionRef as string).startsWith("offline-")).toBe(true);
  });

  it("uses a broadcast txHash when a submit hook ran", async () => {
    const signer = new RealCardanoSigner({
      seed: TEST_SEED,
      network: "testnet",
      submit: async () => ({ txHash: "abc123deadbeef", slot: 42 }),
    });
    const connector = new CardanoConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      network: "testnet",
    });
    const inst = await connector.createInstrument({ userId: "set2" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("set2" as UserId),
    });
    const result = await connector.settle(signed);
    expect(result.transactionRef).toBe("abc123deadbeef");
    expect((result.raw as Record<string, unknown>)["broadcast"]).toBe(true);
  });

  it("fails gracefully on a missing signature", async () => {
    const { connector } = buildConnector();
    const result = await connector.settle({
      request: buildRequest(),
      signer: "addr_test1vsomeone",
      signature: "",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});

// ============================================================================
//  Canonical descriptor determinism
// ============================================================================

describe("canonicalTransferDescriptor()", () => {
  it("is deterministic for identical inputs", () => {
    const a = canonicalTransferDescriptor({
      from: "addr_test1a",
      to: "addr_test1b",
      amountAtomic: "1000000",
      network: "testnet",
    });
    const b = canonicalTransferDescriptor({
      from: "addr_test1a",
      to: "addr_test1b",
      amountAtomic: "1000000",
      network: "testnet",
    });
    expect(a).toBe(b);
    expect(a).toContain("cardano-pay/v1");
    expect(a).toContain("asset=lovelace");
  });
});
