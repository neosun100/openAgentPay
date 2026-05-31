/**
 * FireblocksConnector unit tests — exercises the 5-method contract directly
 * (offline, no network): capabilities, instrument lifecycle, balance, EIP-3009
 * signing, real-signature verification (incl. tamper rejection), settlement,
 * keygen determinism, and error paths.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type {
  PaymentRequest,
  Session,
  SessionId,
  UserId,
} from "@openagentpay/core";
import {
  FireblocksConnector,
  MemoryInstrumentStore,
  FIREBLOCKS_PROTOCOL,
  WALLET_PROVIDER_ID,
  RealFireblocksSigner,
  generateFireblocksKeypair,
  keypairFromPrivateKey,
  deriveFireblocksKeypair,
  generateNonce,
} from "../src/index.js";

// ---- fixtures ---------------------------------------------------------------

const KP = deriveFireblocksKeypair("unit-seed", "12");

function makeConnector(extra?: { now?: () => number }) {
  return new FireblocksConnector({
    signer: new RealFireblocksSigner({
      privateKey: KP.privateKey,
      vaultAccountId: "12",
      apiKey: "mock-fireblocks-api-key",
      ...(extra ? {} : {}),
    }),
    instrumentStore: new MemoryInstrumentStore(),
    ...(extra?.now ? { now: extra.now } : {}),
  });
}

function makeSession(userId: UserId): Session {
  const now = new Date();
  return {
    id: `payment-session-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

function makeRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: FIREBLOCKS_PROTOCOL,
    amount: { amountAtomic: "2500", decimals: 6, currency: "USDC" },
    recipient: "0x2222222222222222222222222222222222222222",
    asset: { symbol: "USDC", decimals: 6, chain: "eip155:84532" },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: generateNonce(),
    rawPayload: {},
    ...overrides,
  };
}

// ---- capabilities -----------------------------------------------------------

describe("getCapabilities()", () => {
  it("reports fireblocks provider + x402-v1 protocol", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(FIREBLOCKS_PROTOCOL);
  });

  it("advertises mpc + institutional + policyEngine features, no user approval", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.features?.["mpc"]).toBe(true);
    expect(caps.features?.["institutional"]).toBe(true);
    expect(caps.features?.["policyEngine"]).toBe(true);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
  });

  it("supports USDC + ETH on Base Sepolia", () => {
    const caps = makeConnector().getCapabilities();
    const symbols = caps.supportedAssets.map((a) => a.symbol);
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("ETH");
  });
});

// ---- createInstrument -------------------------------------------------------

describe("createInstrument()", () => {
  it("puts a real 0x vault address in publicHandle + vaultAccountId in metadata", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.providerMetadata?.["vaultAccountId"]).toBe("12");
    expect(inst.providerMetadata?.["custodyModel"]).toBe("mpc-cmp");
  });

  it("is idempotent per userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "u-idem" as UserId });
    const b = await c.createInstrument({ userId: "u-idem" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("rejects empty userId", async () => {
    const c = makeConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(
      /userId is required/
    );
  });
});

// ---- getBalance -------------------------------------------------------------

describe("getBalance()", () => {
  it("returns a USDC Balance for a known instrument", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u-bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.asset.symbol).toBe("USDC");
    expect(() => BigInt(bal.money.amountAtomic)).not.toThrow();
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-fireblocks-nope" as never)
    ).rejects.toThrow(/not found/);
  });
});

// ---- signAuthorization ------------------------------------------------------

describe("signAuthorization()", () => {
  it("produces a non-empty signature + vault signer, echoing the request", async () => {
    const c = makeConnector();
    const userId = "u-sign" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(userId),
    });
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signed.signer).toBe(inst.publicHandle);
    expect(signed.request.protocol).toBe(FIREBLOCKS_PROTOCOL);
    expect(signed.extra?.["vaultAccountId"]).toBe("12");
  });

  it("rejects a mismatched protocol", async () => {
    const c = makeConnector();
    const userId = "u-badproto" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: makeRequest({ protocol: "totally-bogus-v999" as never }),
        session: makeSession(userId),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "bogus-instrument-id" as never,
        request: makeRequest(),
        session: makeSession("x" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });

  it("signature verifies against the vault address (real crypto)", async () => {
    const signer = new RealFireblocksSigner({
      privateKey: KP.privateKey,
      vaultAccountId: "12",
    });
    const c = new FireblocksConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "u-verify" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(userId),
    });
    const extra = signed.extra!;
    const ok = await signer.verify({
      authorization: extra["authorization"] as never,
      signature: signed.signature as `0x${string}`,
      v: extra["v"] as number,
      r: extra["r"] as `0x${string}`,
      s: extra["s"] as `0x${string}`,
      chainId: extra["chainId"] as number,
      verifyingContract: extra["verifyingContract"] as `0x${string}`,
      domainName: extra["domainName"] as string,
    });
    expect(ok).toBe(true);
  });

  it("verify() rejects a tampered authorization (amount changed)", async () => {
    const signer = new RealFireblocksSigner({
      privateKey: KP.privateKey,
      vaultAccountId: "12",
    });
    const c = new FireblocksConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "u-tamper" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      }),
      session: makeSession(userId),
    });
    const extra = signed.extra!;
    const tampered = {
      ...(extra["authorization"] as Record<string, unknown>),
      value: "999999999", // attacker inflates the amount
    };
    const ok = await signer.verify({
      authorization: tampered as never,
      signature: signed.signature as `0x${string}`,
      v: extra["v"] as number,
      r: extra["r"] as `0x${string}`,
      s: extra["s"] as `0x${string}`,
      chainId: extra["chainId"] as number,
      verifyingContract: extra["verifyingContract"] as `0x${string}`,
      domainName: extra["domainName"] as string,
    });
    expect(ok).toBe(false);
  });
});

// ---- settle -----------------------------------------------------------------

describe("settle()", () => {
  it("returns success + a Fireblocks tx id (offline mock) + ISO settledAt", async () => {
    const c = makeConnector();
    const userId = "u-settle" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.success).toBe(true);
    expect(res.network).toBe("base-sepolia");
    expect(typeof res.transactionRef).toBe("string");
    expect((res.transactionRef as string).length).toBeGreaterThan(0);
    expect(res.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("routes through a pluggable submit hook when configured", async () => {
    let seenVault = "";
    const signer = new RealFireblocksSigner({
      privateKey: KP.privateKey,
      vaultAccountId: "7",
      submit: async ({ vaultAccountId }) => {
        seenVault = vaultAccountId;
        return {
          fireblocksTxId: "fb-real-0001",
          txHash: "0xabc123",
        };
      },
    });
    const c = new FireblocksConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "u-hook" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(userId),
    });
    const res = await c.settle(signed);
    expect(res.transactionRef).toBe("fb-real-0001");
    expect((res.raw as Record<string, unknown>)["txHash"]).toBe("0xabc123");
    expect(seenVault).toBe("7");
  });

  it("fails gracefully when signature is missing", async () => {
    const c = makeConnector();
    const res = await c.settle({
      request: makeRequest(),
      signer: "0xdead",
      signature: "",
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("signature_invalid");
  });
});

// ---- keygen -----------------------------------------------------------------

describe("keygen", () => {
  it("generateFireblocksKeypair yields a real 0x address", () => {
    const kp = generateFireblocksKeypair();
    expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(kp.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("keypairFromPrivateKey round-trips to the same address", () => {
    const kp = generateFireblocksKeypair();
    const back = keypairFromPrivateKey(kp.privateKey);
    expect(back.address).toBe(kp.address);
  });

  it("deriveFireblocksKeypair is deterministic per (seed, vaultAccountId)", () => {
    const a = deriveFireblocksKeypair("s", "0");
    const b = deriveFireblocksKeypair("s", "0");
    const c = deriveFireblocksKeypair("s", "1");
    expect(a.address).toBe(b.address);
    expect(a.address).not.toBe(c.address);
  });
});
