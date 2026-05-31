/**
 * NEAR MAINNET wallet connector unit tests.
 *
 * Covers: keygen + implicit-address format (64 hex), mnemonic recovery,
 * ".near" named-account validation, capabilities (mainnet USDC contract +
 * native-NEAR feature), createInstrument (idempotency + empty-userId
 * rejection), getBalance, signAuthorization (real Ed25519 sig + verify +
 * tamper rejection + protocol mismatch + unknown instrument), settle.
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
  NearMainnetConnector,
  DemoNearMainnetSigner,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  NEAR_DECIMALS,
  USDC_DECIMALS,
  NEAR_USDC_MAINNET,
  RealNearMainnetSigner,
  generateNearKeypair,
  keypairFromSeed,
  keypairFromSecretKey,
  keypairFromMnemonic,
  canonicalTransferDescriptor,
  isValidMainnetAccountId,
  IMPLICIT_ACCOUNT_RE,
} from "../src/index.js";

// ---------------------------------------------------------------------------
//  Test helpers
// ---------------------------------------------------------------------------

const TEST_SEED = new Uint8Array(32).fill(9);
// Standard BIP-39 test vector (12 words) — deterministic mainnet recovery.
const TEST_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

function makeConnector(signer = new RealNearMainnetSigner({ seed: TEST_SEED })) {
  return new NearMainnetConnector({
    signer,
    instrumentStore: new MemoryInstrumentStore(),
  });
}

function buildSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: USDC_DECIMALS, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: USDC_DECIMALS, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000000", decimals: NEAR_DECIMALS, currency: "NEAR" },
    recipient: "merchant.near",
    asset: { symbol: "NEAR", decimals: NEAR_DECIMALS },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Keypair / implicit address format
// ---------------------------------------------------------------------------

describe("NEAR mainnet keypair generation", () => {
  it("generates an implicit account = 64 lowercase hex chars (no 0x)", () => {
    const kp = generateNearKeypair();
    expect(kp.accountId).toMatch(IMPLICIT_ACCOUNT_RE);
    expect(kp.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.accountId.startsWith("0x")).toBe(false);
  });

  it("private + public key strings start with ed25519:", () => {
    const kp = generateNearKeypair();
    expect(kp.secretKey.startsWith("ed25519:")).toBe(true);
    expect(kp.publicKey.startsWith("ed25519:")).toBe(true);
  });

  it("is deterministic from a fixed seed", () => {
    const a = keypairFromSeed(TEST_SEED);
    const b = keypairFromSeed(TEST_SEED);
    expect(a.accountId).toBe(b.accountId);
    expect(a.secretKey).toBe(b.secretKey);
  });

  it("round-trips through keypairFromSecretKey", () => {
    const kp = generateNearKeypair();
    const reloaded = keypairFromSecretKey(kp.secretKey);
    expect(reloaded.accountId).toBe(kp.accountId);
    expect(reloaded.publicKey).toBe(kp.publicKey);
  });

  it("recovers deterministically from a BIP-39 mnemonic", () => {
    const a = keypairFromMnemonic(TEST_MNEMONIC);
    const b = keypairFromMnemonic(TEST_MNEMONIC);
    expect(a.accountId).toBe(b.accountId);
    expect(a.accountId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an invalid BIP-39 mnemonic", () => {
    expect(() => keypairFromMnemonic("not a real seed phrase at all nope")).toThrow(
      /Invalid BIP-39 mnemonic/
    );
  });

  it("rejects a 32-byte seed of wrong length", () => {
    expect(() => keypairFromSeed(new Uint8Array(31))).toThrow();
  });

  it("rejects a secret key missing the ed25519: prefix", () => {
    expect(() => keypairFromSecretKey("notaprefix")).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  Mainnet account-id validation (.near named accounts)
// ---------------------------------------------------------------------------

describe("isValidMainnetAccountId()", () => {
  it("accepts a 64-hex implicit account", () => {
    expect(isValidMainnetAccountId("a".repeat(64))).toBe(true);
    expect(isValidMainnetAccountId(generateNearKeypair().accountId)).toBe(true);
  });

  it("accepts a .near named account (incl. sub-accounts)", () => {
    expect(isValidMainnetAccountId("alice.near")).toBe(true);
    expect(isValidMainnetAccountId("my-agent.near")).toBe(true);
    expect(isValidMainnetAccountId("sub.alice.near")).toBe(true);
  });

  it("rejects a .testnet account on mainnet", () => {
    expect(isValidMainnetAccountId("alice.testnet")).toBe(false);
  });

  it("rejects a bare name without a TLD", () => {
    expect(isValidMainnetAccountId("alice")).toBe(false);
  });

  it("RealNearMainnetSigner throws on a non-.near named account", () => {
    expect(
      () => new RealNearMainnetSigner({ seed: TEST_SEED, accountId: "alice.testnet" })
    ).toThrow(/must end in "\.near"/);
  });

  it("RealNearMainnetSigner accepts a .near named account override", () => {
    const signer = new RealNearMainnetSigner({
      seed: TEST_SEED,
      accountId: "alice.near",
    });
    expect(signer.accountId).toBe("alice.near");
    // implicit account is still derived from the keypair and is 64-hex
    expect(signer.implicitAccountId).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
//  Capabilities
// ---------------------------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports the near-mainnet provider and near-pay-v1 protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.walletProvider).toBe("near-mainnet");
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
  });

  it("exposes USDC (6dp, mainnet NEP-141 contract) as the payment asset", () => {
    const caps = makeConnector().getCapabilities();
    const usdc = caps.supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.contract).toBe(NEAR_USDC_MAINNET);
  });

  it("surfaces native NEAR (24dp) via feature flag, within the 24dp ceiling", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.features?.["nativeNear"]).toBe(true);
    expect(caps.features?.["nativeNearDecimals"]).toBe(24);
    expect(caps.features?.["mainnet"]).toBe(true);
    expect(caps.features?.["network"]).toBe("mainnet");
  });

  it("settles on chain and is non-EVM", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["nonEvm"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("createInstrument()", () => {
  it("binds the signer implicit account as publicHandle (64 hex)", async () => {
    const signer = new RealNearMainnetSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle).toBe(signer.accountId);
    expect(inst.publicHandle).toMatch(/^[0-9a-f]{64}$/);
    expect(inst.walletProvider).toBe("near-mainnet");
  });

  it("binds a .near named account when the signer uses one", async () => {
    const signer = new RealNearMainnetSigner({
      seed: TEST_SEED,
      accountId: "agent.near",
    });
    const c = makeConnector(signer);
    const inst = await c.createInstrument({ userId: "named1" as UserId });
    expect(inst.publicHandle).toBe("agent.near");
  });

  it("is idempotent per userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "u2" as UserId });
    const b = await c.createInstrument({ userId: "u2" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("rejects empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("getBalance()", () => {
  it("returns a USDC balance for a known instrument", async () => {
    const signer = new DemoNearMainnetSigner({
      accountId: "f".repeat(64),
      initialBalanceAtomic: "5000000",
    });
    const c = new NearMainnetConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "u3" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("5000000");
    expect(bal.money.currency).toBe("USDC");
    expect(bal.asset.contract).toBe(NEAR_USDC_MAINNET);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-near-mainnet-nope" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a real, verifiable Ed25519 signature", async () => {
    const signer = new RealNearMainnetSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const userId = "u4" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signer).toBe(signer.accountId);

    const descriptor = canonicalTransferDescriptor({
      from: signer.accountId,
      to: req.recipient,
      amountAtomic: req.amount.amountAtomic,
      reference: req.nonce,
    });
    expect(signer.verify(signed.signature, descriptor)).toBe(true);
  });

  it("a tampered message fails verification", async () => {
    const signer = new RealNearMainnetSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const userId = "u5" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.accountId,
      to: "attacker.near", // tampered recipient
      amountAtomic: req.amount.amountAtomic,
      reference: req.nonce,
    });
    expect(signer.verify(signed.signature, tampered)).toBe(false);
  });

  it("rejects a mismatched protocol", async () => {
    const c = makeConnector();
    const userId = "u6" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "bogus-v9" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/near-pay-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    const userId = "u7" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-near-mainnet-ghost" as InstrumentId,
        request: buildRequest(),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("echoes the request and attaches publicKey + mainnet network in extra", async () => {
    const signer = new RealNearMainnetSigner({ seed: TEST_SEED });
    const c = makeConnector(signer);
    const userId = "u8" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    const extra = signed.extra as Record<string, unknown>;
    expect(extra["publicKey"]).toBe(signer.publicKey);
    expect(extra["network"]).toBe("mainnet");
  });

  it("routes a USDC request through the mainnet NEP-141 token", async () => {
    let seenToken: string | undefined;
    const signer = new RealNearMainnetSigner({
      seed: TEST_SEED,
      submit: async (i) => {
        seenToken = i.token;
        return { blockHash: "BLK", explorerUrl: "https://nearblocks.io/txns/x" };
      },
    });
    const c = makeConnector(signer);
    const userId = "u11" as UserId;
    const inst = await c.createInstrument({ userId });
    await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest({
        amount: { amountAtomic: "1000000", decimals: USDC_DECIMALS, currency: "USDC" },
        asset: { symbol: "USDC", decimals: USDC_DECIMALS, contract: NEAR_USDC_MAINNET },
      }),
      session: buildSession(userId),
    });
    expect(seenToken).toBe(NEAR_USDC_MAINNET);
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("settle()", () => {
  it("returns success with an ISO settledAt, mainnet network + transactionRef", async () => {
    const c = makeConnector();
    const userId = "u9" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("near-mainnet");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof result.transactionRef).toBe("string");
  });

  it("fails with signature_invalid when signature is empty", async () => {
    const c = makeConnector();
    const userId = "u10" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const broken = { ...signed, signature: "" };
    const result = await c.settle(broken);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});

// ---------------------------------------------------------------------------
//  submit hook
// ---------------------------------------------------------------------------

describe("pluggable submit hook", () => {
  it("invokes the broadcast hook when provided", async () => {
    let called = false;
    const signer = new RealNearMainnetSigner({
      seed: TEST_SEED,
      submit: async () => {
        called = true;
        return { blockHash: "BLK123", explorerUrl: "https://nearblocks.io/txns/y" };
      },
    });
    const res = await signer.signAndSubmit({
      recipient: "merchant.near",
      amountAtomic: "1000000",
      reference: "n1",
    });
    expect(called).toBe(true);
    expect(res.blockHash).toBe("BLK123");
  });

  it("returns a real signature with deferred broadcast when no hook", async () => {
    const signer = new RealNearMainnetSigner({ seed: TEST_SEED });
    const res = await signer.signAndSubmit({
      recipient: "merchant.near",
      amountAtomic: "1000000",
      reference: "n2",
    });
    expect(res.signature.length).toBeGreaterThan(0);
    expect(res.explorerUrl).toContain("nearblocks.io");
  });
});
