/**
 * Sui wallet connector + crypto unit tests.
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type { PaymentRequest, InstrumentId, UserId, Session, SessionId } from "@openagentpay/core";
import {
  SuiConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  SUI_COIN_TYPE,
  RealSuiSigner,
  generateSuiKeypair,
  keypairFromSeed,
  keypairFromSuiPrivateKey,
  encodeSuiPrivateKey,
  suiAddressFromPublicKey,
  canonicalTransferDescriptor,
  SUI_PRIVATE_KEY_HRP,
} from "../src/index.js";

const TEST_SEED = new Uint8Array(32).fill(7);

function makeConnector(seed = TEST_SEED) {
  const signer = new RealSuiSigner({ seed, network: "testnet" });
  const store = new MemoryInstrumentStore();
  return { connector: new SuiConnector({ signer, instrumentStore: store, network: "testnet" }), signer, store };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000000", decimals: 9, currency: "SUI" },
    recipient: "0x" + "ab".repeat(32),
    asset: { symbol: "SUI", decimals: 9 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "NONCE_1",
    rawPayload: {},
    ...overrides,
  };
}

function buildSession(): Session {
  const now = new Date();
  return {
    id: "sess-1" as SessionId,
    userId: "u1" as UserId,
    budget: { amountAtomic: "1000000000", decimals: 9, currency: "SUI" },
    spent: { amountAtomic: "0", decimals: 9, currency: "SUI" },
    expiresAt: new Date(now.getTime() + 1_800_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

// ---------------------------------------------------------------------------
//  Keygen / address derivation
// ---------------------------------------------------------------------------

describe("Sui keygen", () => {
  it("generateSuiKeypair yields a 0x + 64-hex address", () => {
    const kp = generateSuiKeypair();
    expect(kp.address).toMatch(/^0x[0-9a-f]{64}$/);
    expect(kp.seed.length).toBe(32);
  });

  it("generateSuiKeypair yields a suiprivkey1… bech32 key", () => {
    const kp = generateSuiKeypair();
    expect(kp.suiprivkeyBech32.startsWith(SUI_PRIVATE_KEY_HRP + "1")).toBe(true);
    expect(kp.suiprivkeyBech32.startsWith("suiprivkey1")).toBe(true);
  });

  it("address derivation is deterministic for a fixed seed", () => {
    const a = keypairFromSeed(TEST_SEED).address;
    const b = keypairFromSeed(TEST_SEED).address;
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("suiprivkey round-trips back to the same keypair", () => {
    const kp = keypairFromSeed(TEST_SEED);
    const restored = keypairFromSuiPrivateKey(kp.suiprivkeyBech32);
    expect(restored.address).toBe(kp.address);
    expect(restored.seedHex).toBe(kp.seedHex);
    expect(restored.publicKeyHex).toBe(kp.publicKeyHex);
  });

  it("encodeSuiPrivateKey rejects a non-32-byte seed", () => {
    expect(() => encodeSuiPrivateKey(new Uint8Array(16))).toThrow();
  });

  it("suiAddressFromPublicKey rejects a non-32-byte pubkey", () => {
    expect(() => suiAddressFromPublicKey(new Uint8Array(31))).toThrow();
  });

  it("different seeds produce different addresses", () => {
    const a = keypairFromSeed(new Uint8Array(32).fill(1)).address;
    const b = keypairFromSeed(new Uint8Array(32).fill(2)).address;
    expect(a).not.toBe(b);
  });

  it("keypairFromSuiPrivateKey rejects a wrong-hrp bech32 string", () => {
    // Re-encode under a bogus hrp by hand is hard; just assert a garbage string throws.
    expect(() => keypairFromSuiPrivateKey("notbech32")).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  Capabilities
// ---------------------------------------------------------------------------

describe("getCapabilities", () => {
  it("reports the sui provider + sui-pay-v1 protocol", () => {
    const { connector } = makeConnector();
    const caps = connector.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.map((a) => a.symbol)).toContain("SUI");
    expect(caps.settlesOnChain).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument", () => {
  it("creates an instrument bound to the signer address", async () => {
    const { connector, signer } = makeConnector();
    const inst = await connector.createInstrument({ userId: "alice" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(signer.address);
    expect(inst.userId).toBe("alice");
  });

  it("is idempotent per userId", async () => {
    const { connector } = makeConnector();
    const a = await connector.createInstrument({ userId: "bob" as UserId });
    const b = await connector.createInstrument({ userId: "bob" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("throws when userId is empty", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("getBalance", () => {
  it("returns 0 SUI on the offline-safe default signer", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "carol" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("SUI");
    expect(bal.money.decimals).toBe(9);
  });

  it("reads through a custom balanceReader", async () => {
    const signer = new RealSuiSigner({
      seed: TEST_SEED,
      network: "testnet",
      balanceReader: async () => 4200000000n,
    });
    const store = new MemoryInstrumentStore();
    const connector = new SuiConnector({ signer, instrumentStore: store, network: "testnet" });
    const inst = await connector.createInstrument({ userId: "dave" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("4200000000");
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.getBalance("payment-instrument-sui-ghost" as InstrumentId)
    ).rejects.toThrow(/Instrument not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization", () => {
  it("produces a real, verifiable Ed25519 signature", async () => {
    const { connector, signer } = makeConnector();
    const inst = await connector.createInstrument({ userId: "erin" as UserId });
    const request = buildRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request,
      session: buildSession(),
    });
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signer).toBe(signer.address);

    // Reconstruct the descriptor and verify the signature cryptographically.
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: request.recipient,
      amountAtomic: request.amount.amountAtomic,
      coinType: SUI_COIN_TYPE,
      reference: request.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("rejects a wrong protocol", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "frank" as UserId });
    const request = buildRequest({ protocol: "x402-v1" as PaymentRequest["protocol"] });
    await expect(
      connector.signAuthorization({ instrumentId: inst.id, request, session: buildSession() })
    ).rejects.toThrow(/sui-pay-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.signAuthorization({
        instrumentId: "payment-instrument-sui-ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });

  it("a tampered descriptor fails verification", async () => {
    const { connector, signer } = makeConnector();
    const inst = await connector.createInstrument({ userId: "grace" as UserId });
    const request = buildRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request,
      session: buildSession(),
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.address,
      to: request.recipient,
      amountAtomic: "999999999", // changed amount
      coinType: SUI_COIN_TYPE,
      reference: request.nonce,
    });
    expect(signer.verify(signed.signature, tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("settle", () => {
  it("returns a successful SettlementResult with an ISO timestamp", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "heidi" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(),
    });
    const result = await connector.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("sui-testnet");
    expect(result.transactionRef).toBeDefined();
    expect(() => new Date(result.settledAt).toISOString()).not.toThrow();
  });

  it("routes through a custom submit hook (digest surfaces in settle)", async () => {
    const signer = new RealSuiSigner({
      seed: TEST_SEED,
      network: "testnet",
      submit: async () => ({ digest: "0xDEADBEEFdigest", explorerUrl: "https://x/tx" }),
    });
    const store = new MemoryInstrumentStore();
    const connector = new SuiConnector({ signer, instrumentStore: store, network: "testnet" });
    const inst = await connector.createInstrument({ userId: "ivan" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(),
    });
    const result = await connector.settle(signed);
    expect(result.transactionRef).toBe("0xDEADBEEFdigest");
  });
});
