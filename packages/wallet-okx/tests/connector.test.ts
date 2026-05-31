/**
 * Unit tests for OkxPayConnector + RealOkxSigner.
 *
 * Coverage:
 *   - capabilities purity + assets/protocol
 *   - createInstrument idempotency, id shape, empty-userId rejection
 *   - getBalance shape + unknown-instrument throw
 *   - signAuthorization wire token + HMAC-SHA256 + wrong-protocol reject + unknown instrument
 *   - settle offline-safe deterministic ref + pluggable submit hook + error mapping
 *   - credential generation (deterministic w/ seed) + loader validation
 *   - verify(): signs then verifies, and a tampered payload fails
 *   - atomic <-> major helpers
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
  OkxPayConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  __internal,
  type OkxSubmitHook,
} from "../src/connector.js";
import {
  RealOkxSigner,
  generateOkxCredential,
  keypairFromCredential,
  verifyOkxSignature,
  type OkxAuthorizationPayload,
} from "../src/real-signer.js";

const FIXED_NOW_MS = 1778860654_000;
const SEED = new Uint8Array(32).fill(7);

function makeConnector(extra?: { submit?: OkxSubmitHook; balanceAtomic?: string }): OkxPayConnector {
  return new OkxPayConnector({
    seed: SEED,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    balanceAtomic: extra?.balanceAtomic ?? "19958000",
    ...(extra?.submit !== undefined ? { submit: extra.submit } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

function makeRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: OAP_CEX_PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
    recipient: "oap-sub-merchant99",
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

describe("OkxPayConnector.getCapabilities", () => {
  it("reports okx provider with USDT/USDC + cex-pay protocol", () => {
    const c = makeConnector();
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(false);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDT")).toBeDefined();
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(OAP_CEX_PROTOCOL_ID);
  });

  it("is pure (equal twice)", () => {
    const c = makeConnector();
    expect(c.getCapabilities().walletProvider).toBe(c.getCapabilities().walletProvider);
  });
});

describe("OkxPayConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector();
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
    expect(a.userId).toBe("alice");
    expect(a.publicHandle).toMatch(/^oap-sub-/);
  });

  it("derives a stable instrument id", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    expect(i.id).toMatch(/^payment-instrument-okx-[0-9a-f]{16}$/);
    expect(i.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("rejects empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });
});

describe("OkxPayConnector.getBalance", () => {
  it("returns USDT balance in atomic units", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const b = await c.getBalance(i.id);
    expect(b.instrumentId).toBe(i.id);
    expect(b.money.currency).toBe("USDT");
    expect(b.money.decimals).toBe(6);
    expect(b.money.amountAtomic).toBe("19958000");
    expect(b.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws when instrument unknown", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-okx-nonexistent" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("OkxPayConnector.signAuthorization", () => {
  it("produces a valid OAP-CEX wire token with HMAC-SHA256 base64 signature", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest(),
      session: makeSession(),
    });
    expect(signed.signer).toMatch(/^oap-sub-/);
    expect(signed.signature.length).toBeGreaterThan(0);
    // base64 (OKX OK-ACCESS-SIGN), not hex
    expect(signed.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decoded = decodeWireToken(signed.encoded!);
    expect(decoded.scheme).toBe("cex-pay");
    expect(decoded.provider).toBe("okx");
    expect(decoded.authorization.amount).toBe("1000");
    expect(decoded.authorization.to).toBe("oap-sub-merchant99");
    expect(decoded.signature.alg).toBe("HMAC-SHA256");
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

  it("throws on unknown instrument", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "bogus" as never,
        request: makeRequest(),
        session: makeSession(),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

describe("OkxPayConnector.settle", () => {
  it("offline-safe: returns a deterministic mock receipt ref", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest({ description: "test order" }),
      session: makeSession(),
    });
    const r = await c.settle(signed);
    expect(r.success).toBe(true);
    expect(r.transactionRef).toMatch(/^okx-receipt-[0-9a-f]{24}$/);
    expect(r.network).toBe("okx-pay-sandbox");
    expect(r.settledAmount).toEqual<Money>(signed.request.amount);
    // deterministic
    const r2 = await c.settle(signed);
    expect(r2.transactionRef).toBe(r.transactionRef);
  });

  it("uses the pluggable submit hook when provided", async () => {
    const submit = vi.fn(async () => ({ transactionRef: "okx-live-tx-777", raw: { ok: 1 } }));
    const c = makeConnector({ submit });
    const i = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const r = await c.settle(signed);
    expect(submit).toHaveBeenCalledOnce();
    expect(r.success).toBe(true);
    expect(r.transactionRef).toBe("okx-live-tx-777");
  });

  it("maps submit-hook errors to canonical codes", async () => {
    const submit = vi.fn(async () => {
      throw { code: "auth", message: "bad signature" };
    });
    const c = makeConnector({ submit });
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

  it("fails gracefully when wire token missing", async () => {
    const c = makeConnector();
    const r = await c.settle({
      request: makeRequest(),
      signer: "oap-sub-x",
      signature: "deadbeef",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });
});

describe("RealOkxSigner credential + verify", () => {
  it("generates a deterministic credential from a seed", () => {
    const a = generateOkxCredential(SEED);
    const b = generateOkxCredential(SEED);
    expect(a.apiKey).toBe(b.apiKey);
    expect(a.apiSecret).toBe(b.apiSecret);
    expect(a.subAccountId).toBe(b.subAccountId);
    expect(a.apiKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.subAccountId).toMatch(/^oap-sub-[0-9a-f]{8}$/);
  });

  it("keypairFromCredential validates all four pieces", () => {
    expect(() =>
      keypairFromCredential({ apiKey: "", apiSecret: "s", passphrase: "p", subAccountId: "sub" })
    ).toThrow(/apiKey/);
    const cred = keypairFromCredential({
      apiKey: "k",
      apiSecret: "s",
      passphrase: "p",
      subAccountId: "sub",
    });
    expect(cred.subAccountId).toBe("sub");
  });

  it("signs then verifies; a tampered payload fails", () => {
    const signer = new RealOkxSigner({ seed: SEED });
    const payload: OkxAuthorizationPayload = {
      asset: "USDT",
      amount: "1000",
      amountDecimals: 6,
      from: signer.subAccountId,
      to: "oap-sub-merchant99",
      nonce: "0xabcd",
      validBefore: 9_999_999_999,
      signedAt: 1778860654,
    };
    const sig = signer.sign(payload);
    expect(signer.verify(payload, sig)).toBe(true);
    // stateless verifier agrees
    expect(verifyOkxSignature(signer.credential.apiSecret, payload, sig)).toBe(true);
    // tampered amount → fail
    const tampered = { ...payload, amount: "9999" };
    expect(signer.verify(tampered, sig)).toBe(false);
    // wrong secret → fail
    expect(verifyOkxSignature("not-the-secret", payload, sig)).toBe(false);
  });
});

describe("__internal helpers", () => {
  it("toAtomic: 19.958 / 6 → 19958000", () => {
    expect(__internal.toAtomic("19.958", 6)).toBe("19958000");
  });
  it("toAtomic: 0 / 6 → 0", () => {
    expect(__internal.toAtomic("0", 6)).toBe("0");
  });
  it("atomicToMajor: 1000 / 6 → 0.001000", () => {
    expect(__internal.atomicToMajor("1000", 6)).toBe("0.001000");
  });
});
