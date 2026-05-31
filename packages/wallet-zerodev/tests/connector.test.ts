/**
 * ZeroDevConnector unit tests — capabilities, instrument lifecycle, balance,
 * UserOp signing (real secp256k1), settle, keygen, counterfactual address
 * derivation, and error paths.
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
  ZeroDevConnector,
  MemoryInstrumentStore,
  ZERODEV_PROTOCOL,
  BASE_SEPOLIA_USDC,
  RealZeroDevSigner,
  generateZeroDevOwner,
  ownerFromPrivateKey,
  deriveSmartAccountAddress,
  userOpHash,
  canonicalUserOpDescriptor,
  ENTRYPOINT_V07,
} from "../src/index.js";

const TEST_OWNER_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000003" as const;

function makeConnector(opts: { balance?: bigint } = {}) {
  const signer = new RealZeroDevSigner({
    ownerPrivateKey: TEST_OWNER_KEY,
    salt: ("0x" + "00".repeat(31) + "07") as `0x${string}`,
    ...(opts.balance !== undefined
      ? { balanceReader: async () => opts.balance! }
      : {}),
  });
  return new ZeroDevConnector({
    signer,
    instrumentStore: new MemoryInstrumentStore(),
  });
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: ZERODEV_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: "0x000000000000000000000000000000000000dEaD",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "0x" + "1".repeat(64),
    rawPayload: {},
    ...overrides,
  };
}

function buildSession(userId: UserId): Session {
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

describe("ZeroDevConnector — capabilities", () => {
  it("reports zerodev provider + x402-v1 + smart-account features", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe("zerodev");
    expect(caps.supportedProtocols).toContain(ZERODEV_PROTOCOL);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.features?.["smartAccount"]).toBe(true);
    expect(caps.features?.["erc4337"]).toBe(true);
    expect(caps.features?.["sponsoredGas"]).toBe(true);
    expect(caps.features?.["onChainSpendingLimits"]).toBe(true);
  });

  it("supports USDC on Base Sepolia (6 decimals)", () => {
    const caps = makeConnector().getCapabilities();
    const usdc = caps.supportedAssets.find((a) => a.symbol === "USDC");
    expect(usdc).toBeDefined();
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.contract).toBe(BASE_SEPOLIA_USDC);
  });
});

describe("ZeroDevConnector — keygen + counterfactual address", () => {
  it("generates a real owner EOA (0x + 40 hex)", () => {
    const { ownerPrivateKey, ownerAddress } = generateZeroDevOwner();
    expect(ownerPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(ownerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("ownerFromPrivateKey is deterministic", () => {
    const a = ownerFromPrivateKey(TEST_OWNER_KEY);
    const b = ownerFromPrivateKey(TEST_OWNER_KEY);
    expect(a.ownerAddress).toBe(b.ownerAddress);
  });

  it("smart-account address is a valid EVM address, deterministic per owner+salt", () => {
    const owner = ownerFromPrivateKey(TEST_OWNER_KEY).ownerAddress;
    const salt = ("0x" + "00".repeat(31) + "07") as `0x${string}`;
    const sa1 = deriveSmartAccountAddress(owner, salt);
    const sa2 = deriveSmartAccountAddress(owner, salt);
    expect(sa1).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(sa1).toBe(sa2);
  });

  it("different salt → different smart account; smart account != owner", () => {
    const owner = ownerFromPrivateKey(TEST_OWNER_KEY).ownerAddress;
    const sa1 = deriveSmartAccountAddress(owner, ("0x" + "00".repeat(31) + "01") as `0x${string}`);
    const sa2 = deriveSmartAccountAddress(owner, ("0x" + "00".repeat(31) + "02") as `0x${string}`);
    expect(sa1).not.toBe(sa2);
    expect(sa1.toLowerCase()).not.toBe(owner.toLowerCase());
  });

  it("signer exposes both owner and smart-account addresses (distinct)", () => {
    const signer = new RealZeroDevSigner({ ownerPrivateKey: TEST_OWNER_KEY });
    expect(signer.ownerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(signer.smartAccountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(signer.smartAccountAddress.toLowerCase()).not.toBe(
      signer.ownerAddress.toLowerCase()
    );
    expect(signer.entryPoint).toBe(ENTRYPOINT_V07);
  });
});

describe("ZeroDevConnector — createInstrument", () => {
  it("publicHandle = smart account; owner in providerMetadata", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u1" as UserId });
    expect(inst.publicHandle).toBe(c.smartAccountAddress);
    expect(inst.providerMetadata?.["ownerAddress"]).toBe(c.ownerAddress);
    expect(inst.providerMetadata?.["accountType"]).toBe("erc4337-kernel");
    expect(inst.walletProvider).toBe("zerodev");
  });

  it("is idempotent per userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "same" as UserId });
    const b = await c.createInstrument({ userId: "same" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("throws on empty userId", async () => {
    const c = makeConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(
      /userId is required/
    );
  });
});

describe("ZeroDevConnector — getBalance", () => {
  it("returns USDC balance from the smart account", async () => {
    const c = makeConnector({ balance: 4_200_000n });
    const inst = await c.createInstrument({ userId: "bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(bal.money.amountAtomic).toBe("4200000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.asset.symbol).toBe("USDC");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-does-not-exist" as InstrumentId)
    ).rejects.toThrow(/not found/);
  });
});

describe("ZeroDevConnector — signAuthorization", () => {
  it("produces a real secp256k1 signature verifiable against the owner", async () => {
    const signer = new RealZeroDevSigner({ ownerPrivateKey: TEST_OWNER_KEY });
    const c = new ZeroDevConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "sign" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signed.signature.length).toBeGreaterThan(2);
    // signer field = the smart account (on-chain sender)
    expect(signed.signer).toBe(signer.smartAccountAddress);
    expect(signed.extra?.["ownerAddress"]).toBe(signer.ownerAddress);

    // Cryptographic verification against the owner EOA.
    const descriptor = signed.extra?.["descriptor"] as Parameters<
      RealZeroDevSigner["verify"]
    >[1];
    const ok = await signer.verify(signed.signature as `0x${string}`, descriptor);
    expect(ok).toBe(true);
  });

  it("echoes the request and attaches a userOpHash (0x + 64)", async () => {
    const c = makeConnector();
    const userId = "sign2" as UserId;
    const inst = await c.createInstrument({ userId });
    const req = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession(userId),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    expect(signed.request.amount.amountAtomic).toBe(req.amount.amountAtomic);
    expect(signed.extra?.["userOpHash"]).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(signed.extra?.["sponsoredGas"]).toBe(true);
  });

  it("rejects a request whose protocol is not x402-v1", async () => {
    const c = makeConnector();
    const userId = "sign3" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "solana-pay-v1" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/x402-v1/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "bogus" as InstrumentId,
        request: buildRequest(),
        session: buildSession("x" as UserId),
      })
    ).rejects.toThrow(/not found/);
  });
});

describe("ZeroDevConnector — settle", () => {
  it("offline settle returns success with userOpHash as transactionRef", async () => {
    const c = makeConnector();
    const userId = "settle" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.network).toBe("base-sepolia");
    expect(result.transactionRef).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("settle with a bundler submit hook uses the bundler userOpHash + txHash", async () => {
    const fakeUserOpHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const fakeTx = ("0x" + "cd".repeat(32)) as `0x${string}`;
    const signer = new RealZeroDevSigner({
      ownerPrivateKey: TEST_OWNER_KEY,
      submit: async () => ({ userOpHash: fakeUserOpHash, txHash: fakeTx }),
    });
    const c = new ZeroDevConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "settle-live" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    expect(signed.extra?.["userOpHash"]).toBe(fakeUserOpHash);
    expect(signed.extra?.["txHash"]).toBe(fakeTx);
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe(fakeUserOpHash);
    expect((result.raw as Record<string, unknown>)["txHash"]).toBe(fakeTx);
  });
});

describe("userOp descriptor", () => {
  it("canonical descriptor is deterministic + carries spending fields", () => {
    const signer = new RealZeroDevSigner({ ownerPrivateKey: TEST_OWNER_KEY });
    const d = {
      sender: signer.smartAccountAddress,
      to: "0x000000000000000000000000000000000000dEaD" as `0x${string}`,
      token: BASE_SEPOLIA_USDC,
      amountAtomic: "1000",
      nonce: "0x" + "1".repeat(64),
      entryPoint: signer.entryPoint,
      chainId: signer.chainId,
      sponsoredGas: true,
    };
    const s1 = canonicalUserOpDescriptor(d);
    const s2 = canonicalUserOpDescriptor(d);
    expect(s1).toBe(s2);
    expect(s1).toContain("amount=1000");
    expect(s1).toContain("sponsoredGas=1");
    expect(userOpHash(d)).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
