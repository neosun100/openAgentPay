/**
 * StripePrivyConnector unit tests — capabilities, instrument lifecycle, balance,
 * EIP-712 signing (verifiable), settle (offline + pluggable hook), keygen, errors.
 *
 * Runs fully offline: the secp256k1 EIP-712 signing path is real; broadcast is
 * mocked (deterministic) unless a `submit` hook is supplied.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import {
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import type {
  PaymentRequest,
  ProtocolId,
  Session,
  SessionId,
  UserId,
} from "@openagentpay/core";
import {
  StripePrivyConnector,
  MemoryInstrumentStore,
  STRIPE_PRIVY_PROTOCOL,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import {
  createEmbeddedWallet,
  generateEmbeddedWalletKey,
  generateNonce,
  EIP712_TYPES,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  type Eip3009SignedAuthorization,
} from "../src/embedded-wallet.js";

// Deterministic throwaway key (NEVER use for real funds).
const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PRIVY_APP_ID = "privy-app-mock-oap";
const PRIVY_APP_SECRET = "privy-secret-mock-do-not-commit";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as Address;

function makeConnector(opts: {
  submit?: import("../src/connector.js").SubmitHook;
  balanceReader?: import("../src/connector.js").BalanceReader;
} = {}): StripePrivyConnector {
  return new StripePrivyConnector({
    privy: {
      appId: PRIVY_APP_ID,
      appSecret: PRIVY_APP_SECRET,
      privateKey: TEST_PRIVATE_KEY,
    },
    instrumentStore: new MemoryInstrumentStore(),
    ...(opts.submit !== undefined ? { submit: opts.submit } : {}),
    ...(opts.balanceReader !== undefined ? { balanceReader: opts.balanceReader } : {}),
  });
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: STRIPE_PRIVY_PROTOCOL,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: RECIPIENT,
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

describe("StripePrivyConnector — capabilities", () => {
  it("reports stripe-privy provider, x402-v1 protocol, USDC, managed-wallet", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(STRIPE_PRIVY_PROTOCOL);
    expect(caps.supportedAssets[0]?.symbol).toBe("USDC");
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.features?.["managedWallet"]).toBe(true);
    expect(caps.features?.["agentCorePathD"]).toBe(true);
  });
});

describe("StripePrivyConnector — embedded wallet keygen", () => {
  it("mints a real 0x EVM address (42 chars, 40 hex)", () => {
    const w = createEmbeddedWallet({
      appId: PRIVY_APP_ID,
      appSecret: PRIVY_APP_SECRET,
      privateKey: TEST_PRIVATE_KEY,
    });
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.wallet.chainType).toBe("ethereum");
    expect(w.wallet.id.startsWith("privy-wallet-")).toBe(true);
  });

  it("generateEmbeddedWalletKey yields a valid 32-byte hex key", () => {
    const k = generateEmbeddedWalletKey();
    expect(k).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("random keys produce distinct addresses", () => {
    const a = createEmbeddedWallet({ appId: "a", appSecret: "s" });
    const b = createEmbeddedWallet({ appId: "a", appSecret: "s" });
    expect(a.address).not.toBe(b.address);
  });

  it("requires appId and appSecret", () => {
    expect(() => createEmbeddedWallet({ appId: "", appSecret: "s" })).toThrow();
    expect(() => createEmbeddedWallet({ appId: "a", appSecret: "" })).toThrow();
  });
});

describe("StripePrivyConnector — createInstrument", () => {
  it("creates an instrument bound to the embedded wallet address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u-1" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(c.walletAddress);
    expect(inst.providerMetadata?.["custody"]).toBe("managed");
    expect(inst.providerMetadata?.["privyWalletId"]).toBe(c.privyWalletId);
  });

  it("is idempotent per userId", async () => {
    const c = makeConnector();
    const a = await c.createInstrument({ userId: "u-idem" as UserId });
    const b = await c.createInstrument({ userId: "u-idem" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("throws on empty userId", async () => {
    const c = makeConnector();
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(
      /userId is required/
    );
  });
});

describe("StripePrivyConnector — getBalance", () => {
  it("returns 0 offline (no balance reader)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument({ userId: "u-bal" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("USDC");
    expect(bal.asset.contract).toBe(BASE_SEPOLIA_USDC);
  });

  it("uses pluggable balance reader when supplied", async () => {
    const c = makeConnector({ balanceReader: async () => 5_000_000n });
    const inst = await c.createInstrument({ userId: "u-bal2" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("5000000");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(c.getBalance("no-such-instrument" as never)).rejects.toThrow(
      /not found/
    );
  });
});

describe("StripePrivyConnector — signAuthorization", () => {
  it("produces a real, verifiable EIP-712 secp256k1 signature", async () => {
    const c = makeConnector();
    const userId = "u-sign" as UserId;
    const inst = await c.createInstrument({ userId });
    const request = buildRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request,
      session: buildSession(userId),
    });

    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signed.signature.length).toBeGreaterThan(2);
    expect(signed.signer).toBe(c.walletAddress);

    // Cryptographic verification: recover the signer from the typed data.
    const wire = signed.extra?.["signed"] as Eip3009SignedAuthorization;
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "USDC",
        version: "2",
        chainId: BigInt(BASE_SEPOLIA_CHAIN_ID),
        verifyingContract: BASE_SEPOLIA_USDC,
      },
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: wire.authorization.from,
        to: wire.authorization.to,
        value: BigInt(wire.authorization.value),
        validAfter: BigInt(wire.authorization.validAfter),
        validBefore: BigInt(wire.authorization.validBefore),
        nonce: wire.authorization.nonce,
      },
      signature: signed.signature as Hex,
    });
    expect(recovered.toLowerCase()).toBe(c.walletAddress.toLowerCase());
  });

  it("echoes the request and binds to chainId 84532", async () => {
    const c = makeConnector();
    const userId = "u-sign2" as UserId;
    const inst = await c.createInstrument({ userId });
    const request = buildRequest({ amount: { amountAtomic: "2500", decimals: 6, currency: "USDC" } });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request,
      session: buildSession(userId),
    });
    expect(signed.request.amount.amountAtomic).toBe("2500");
    expect(signed.extra?.["chainId"]).toBe(BASE_SEPOLIA_CHAIN_ID);
  });

  it("rejects a mismatched protocol", async () => {
    const c = makeConnector();
    const userId = "u-sign3" as UserId;
    const inst = await c.createInstrument({ userId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "solana-pay-v1" as ProtocolId }),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    const userId = "u-sign4" as UserId;
    await expect(
      c.signAuthorization({
        instrumentId: "bogus" as never,
        request: buildRequest(),
        session: buildSession(userId),
      })
    ).rejects.toThrow(/not found/);
  });
});

describe("StripePrivyConnector — settle", () => {
  it("offline settle returns success + deterministic mock tx hash (0x+64)", async () => {
    const c = makeConnector();
    const userId = "u-settle" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const r1 = await c.settle(signed);
    const r2 = await c.settle(signed);
    expect(r1.success).toBe(true);
    expect(r1.network).toBe("base-sepolia");
    expect(r1.transactionRef).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(r1.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r1.transactionRef).toBe(r2.transactionRef); // deterministic
  });

  it("routes through a pluggable submit hook when supplied", async () => {
    const realHash = "0x" + "ab".repeat(32);
    const c = makeConnector({ submit: async () => ({ transactionRef: realHash }) });
    const userId = "u-settle2" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const r = await c.settle(signed);
    expect(r.success).toBe(true);
    expect(r.transactionRef).toBe(realHash);
  });

  it("fails gracefully when signed.extra.signed is missing", async () => {
    const c = makeConnector();
    const r = await c.settle({
      request: buildRequest(),
      signer: c.walletAddress,
      signature: "0xdeadbeef",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });

  it("maps a throwing submit hook to rpc_error", async () => {
    const c = makeConnector({
      submit: async () => {
        throw new Error("facilitator down");
      },
    });
    const userId = "u-settle3" as UserId;
    const inst = await c.createInstrument({ userId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession(userId),
    });
    const r = await c.settle(signed);
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("rpc_error");
  });
});

describe("StripePrivyConnector — nonce helper", () => {
  it("generateNonce returns a 32-byte 0x hex", () => {
    expect(generateNonce()).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(makeConnector().generateNonce()).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
