/**
 * Unit tests for BybitPayConnector + RealBybitSigner.
 *
 * Coverage:
 *   - getCapabilities is pure & reports bybit + cex-pay-v0.1
 *   - createInstrument is idempotent + stable id shape
 *   - createInstrument rejects empty userId (the contract fix)
 *   - getBalance returns atomic units / throws on unknown instrument
 *   - signAuthorization produces a verifiable HMAC-SHA256 OAP-CEX token
 *   - tampered message fails verification
 *   - signAuthorization rejects wrong protocol + unknown instrument
 *   - settle offline returns deterministic Bybit tx ref
 *   - settle with custom submit hook + error mapping
 *   - keygen: generate + deterministic keypairFromSecret
 *   - error-code mapping helper
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type SessionId,
  type UserId,
} from "@openagentpay/core";
import {
  decodeWireToken,
  PROTOCOL_ID as OAP_CEX_PROTOCOL_ID,
} from "@openagentpay/protocol-cex-pay";
import {
  BybitPayConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  __internal,
  type BybitSubmitHook,
} from "../src/connector.js";
import {
  RealBybitSigner,
  buildPreimage,
  generateBybitKeypair,
  keypairFromSecret,
} from "../src/real-signer.js";

const FIXED_NOW_MS = 1778860654_000;
const CRED = keypairFromSecret("unit-test-seed");
const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

function makeConnector(submit?: BybitSubmitHook): BybitPayConnector {
  return new BybitPayConnector({
    credential: CRED,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(submit ? { submit } : {}),
  });
}

function makeRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: OAP_CEX_PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
    recipient: "bybit-merchant-9001",
    asset: { symbol: "USDT", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0xabcd",
    rawPayload: {},
    ...overrides,
  };
}

function makeSession() {
  const usd: Money = { amountAtomic: "1000000", decimals: 6, currency: "USDC" };
  return {
    id: "sess-1" as SessionId,
    userId: userAlice,
    budget: usd,
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" } as Money,
    expiresAt: new Date(FIXED_NOW_MS + 3_600_000).toISOString(),
    createdAt: new Date(FIXED_NOW_MS).toISOString(),
    updatedAt: new Date(FIXED_NOW_MS).toISOString(),
    status: "active" as const,
  };
}

describe("BybitPayConnector.getCapabilities", () => {
  it("reports bybit provider, cex-pay protocol, off-chain + gas-free", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.displayName).toBe("Bybit Pay");
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(false);
    expect(caps.supportedProtocols).toContain(OAP_CEX_PROTOCOL_ID);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDT")).toBeDefined();
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
  });

  it("is pure (two calls equal)", () => {
    const c = makeConnector();
    expect(c.getCapabilities().walletProvider).toBe(
      c.getCapabilities().walletProvider
    );
  });
});

describe("BybitPayConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector();
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
    expect(a.userId).toBe("alice");
  });

  it("derives a stable bybit instrument id + numeric publicHandle", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    expect(i.id).toMatch(/^payment-instrument-bybit-[0-9a-f]{16}$/);
    expect(i.publicHandle).toMatch(/^bybit-\d{10}$/);
    expect(i.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("rejects empty userId (contract fix)", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

describe("BybitPayConnector.getBalance", () => {
  it("returns USDT balance in atomic units", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const b = await c.getBalance(i.id);
    expect(b.instrumentId).toBe(i.id);
    expect(b.money.currency).toBe("USDT");
    expect(b.money.decimals).toBe(6);
    expect(BigInt(b.money.amountAtomic) >= 0n).toBe(true);
  });

  it("throws when instrument unknown", async () => {
    const c = makeConnector();
    await expect(
      // @ts-expect-error testing invalid input
      c.getBalance("payment-instrument-bybit-nope")
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("BybitPayConnector.signAuthorization", () => {
  it("produces a verifiable HMAC-SHA256 OAP-CEX wire token", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest(),
      session: makeSession(),
    });
    expect(signed.signer).toBe(i.publicHandle);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/); // SHA256 hex lower
    expect(signed.encoded).toBeDefined();

    const decoded = decodeWireToken(signed.encoded!);
    expect(decoded.scheme).toBe("cex-pay");
    expect(decoded.provider).toBe("bybit");
    expect(decoded.authorization.amount).toBe("1000");
    expect(decoded.authorization.to).toBe("bybit-merchant-9001");
    expect(decoded.signature.alg).toBe("HMAC-SHA256");

    // The connector can verify its own signature.
    expect(c.verify(signed)).toBe(true);
  });

  it("verification fails when signature is tampered", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const tampered = {
      ...signed,
      signature: signed.signature.replace(/.$/, (ch) =>
        ch === "a" ? "b" : "a"
      ),
    };
    expect(c.verify(tampered)).toBe(false);
  });

  it("rejects wrong protocol id", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    await expect(
      c.signAuthorization({
        instrumentId: i.id,
        request: makeRequest({ protocol: "x402-v1" as ProtocolId }),
        session: makeSession(),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("rejects unknown instrument", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "payment-instrument-bybit-ghost" as never,
        request: makeRequest(),
        session: makeSession(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("BybitPayConnector.settle", () => {
  it("offline submit returns deterministic Bybit tx ref", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest({ description: "test order" }),
      session: makeSession(),
    });
    const r1 = await c.settle(signed);
    const r2 = await c.settle(signed);
    expect(r1.success).toBe(true);
    expect(r1.network).toBe("bybit-pay-testnet");
    expect(r1.transactionRef).toMatch(/^BYBIT_[0-9A-F]{24}$/);
    expect(r1.settledAmount).toEqual<Money>(makeRequest().amount);
    expect(r1.transactionRef).toBe(r2.transactionRef); // deterministic
  });

  it("uses a custom submit hook when provided", async () => {
    const hook = vi.fn(async () => ({ transactionId: "CUSTOM_TX_42" }));
    const c = makeConnector(hook);
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const r = await c.settle(signed);
    expect(hook).toHaveBeenCalledOnce();
    expect(r.success).toBe(true);
    expect(r.transactionRef).toBe("CUSTOM_TX_42");
  });

  it("maps a thrown submit error to a canonical errorCode", async () => {
    const hook: BybitSubmitHook = async () => {
      throw { code: "auth", message: "bad signature" };
    };
    const c = makeConnector(hook);
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const r = await c.settle(signed);
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });

  it("returns signature_invalid when wire token missing", async () => {
    const c = makeConnector();
    const r = await c.settle({
      request: makeRequest(),
      signer: "x",
      signature: "y",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });
});

describe("RealBybitSigner keygen + sign/verify", () => {
  it("generateBybitKeypair mints real-shaped credentials", () => {
    const k = generateBybitKeypair();
    expect(k.apiKey).toMatch(/^[A-Za-z0-9]{18}$/);
    expect(k.apiSecret).toMatch(/^[A-Za-z0-9]{36}$/);
    expect(k.accountId).toMatch(/^bybit-\d{10}$/);
  });

  it("keypairFromSecret is deterministic", () => {
    const a = keypairFromSecret("same-seed");
    const b = keypairFromSecret("same-seed");
    const c = keypairFromSecret("different-seed");
    expect(a).toEqual(b);
    expect(a.apiKey).not.toBe(c.apiKey);
  });

  it("sign produces verifiable HMAC, tamper fails", () => {
    const signer = new RealBybitSigner({ credential: CRED });
    const params = {
      timestamp: "1778860654000",
      apiKey: CRED.apiKey,
      recvWindow: "5000",
      payload: JSON.stringify({ a: 1 }),
    };
    const sig = signer.sign(params);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signer.verify(params, sig)).toBe(true);
    expect(RealBybitSigner.verify(CRED.apiSecret, params, sig)).toBe(true);
    // tamper preimage
    expect(signer.verify({ ...params, payload: '{"a":2}' }, sig)).toBe(false);
    // tamper signature length
    expect(signer.verify(params, sig.slice(0, 10))).toBe(false);
  });

  it("buildPreimage concatenates per Bybit V5 spec", () => {
    expect(
      buildPreimage({
        timestamp: "1",
        apiKey: "K",
        recvWindow: "5000",
        payload: "P",
      })
    ).toBe("1K5000P");
  });
});

describe("__internal.mapBybitErrorToCode", () => {
  it("maps known codes and falls back to unknown", () => {
    expect(__internal.mapBybitErrorToCode("rate_limited")).toBe("rate_limited");
    expect(__internal.mapBybitErrorToCode("insufficient")).toBe(
      "insufficient_funds"
    );
    expect(__internal.mapBybitErrorToCode("timeout")).toBe("rpc_error");
    expect(__internal.mapBybitErrorToCode("???")).toBe("unknown");
    expect(__internal.mapBybitErrorToCode(undefined)).toBe("unknown");
  });
});
