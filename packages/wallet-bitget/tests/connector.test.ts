/**
 * Unit tests for @openagentpay/wallet-bitget.
 *
 * Covers: keygen, HMAC sign/verify (incl. tamper-detection), capabilities,
 * createInstrument (idempotency + empty-userId rejection), getBalance,
 * signAuthorization (protocol guard + unknown instrument), settle (success
 * mock + pluggable hook + tamper rejection).
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import type {
  PaymentRequest,
  ProtocolId,
  Session,
  SessionId,
  UserId,
} from "@openagentpay/core";
import {
  BitgetPayConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  RealBitgetSigner,
  generateBitgetKeypair,
  keypairFromSeed,
  keypairFromParts,
  hmacSign,
  hmacVerify,
  canonicalize,
  type BitgetAuthPayload,
} from "../src/index.js";

// ---- fixtures ---------------------------------------------------------------

function makeConnector(overrides?: { submit?: RealBitgetSigner["settle"] }): {
  connector: BitgetPayConnector;
  signer: RealBitgetSigner;
} {
  const signer = new RealBitgetSigner({ seed: "unit-test-seed", sandbox: true });
  const connector = new BitgetPayConnector({
    signer,
    instrumentStore: new MemoryInstrumentStore(),
  });
  void overrides;
  return { connector, signer };
}

function buildRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
    recipient: "bg_merchant_recipient01",
    asset: { symbol: "USDT", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "REF_UNIT",
    rawPayload: {},
    ...overrides,
  };
}

function buildSession(userId: UserId): Session {
  return {
    id: `payment-session-unit-${userId}` as SessionId,
    userId,
    budget: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDT" },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
  };
}

const samplePayload: BitgetAuthPayload = {
  asset: "USDT",
  amount: "1000",
  amountDecimals: 6,
  from: "bg_merchant_from",
  to: "bg_merchant_to",
  nonce: "REF_X",
  validBefore: 9_999_999_999,
  signedAt: 1_700_000_000,
};

// ---- keygen -----------------------------------------------------------------

describe("keygen", () => {
  it("generateBitgetKeypair mints a realistic, unique credential", () => {
    const a = generateBitgetKeypair();
    const b = generateBitgetKeypair();
    expect(a.merchantId).toMatch(/^bg_merchant_[0-9a-f]{8}$/);
    expect(a.apiKey).toMatch(/^bg_[0-9a-f]{24}$/);
    expect(a.apiSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.apiSecret).not.toBe(b.apiSecret); // entropy
  });

  it("keypairFromSeed is deterministic", () => {
    const a = keypairFromSeed("seed-1");
    const b = keypairFromSeed("seed-1");
    const c = keypairFromSeed("seed-2");
    expect(a).toEqual(b);
    expect(a.apiSecret).not.toBe(c.apiSecret);
  });

  it("keypairFromParts derives a stable merchantId from apiKey", () => {
    const cred = keypairFromParts({ apiKey: "bg_abc", apiSecret: "deadbeef" });
    expect(cred.merchantId).toMatch(/^bg_merchant_[0-9a-f]{8}$/);
    expect(keypairFromParts({ apiKey: "bg_abc", apiSecret: "x" }).merchantId).toBe(
      cred.merchantId
    );
  });

  it("keypairFromParts rejects missing apiKey/apiSecret", () => {
    expect(() => keypairFromParts({ apiKey: "", apiSecret: "x" })).toThrow(
      /apiKey is required/
    );
    expect(() => keypairFromParts({ apiKey: "k", apiSecret: "" })).toThrow(
      /apiSecret is required/
    );
  });
});

// ---- HMAC sign / verify -----------------------------------------------------

describe("HMAC sign/verify", () => {
  it("hmacSign produces a deterministic upper-hex SHA256 (64 chars)", () => {
    const sig = hmacSign("secret", samplePayload);
    expect(sig).toMatch(/^[0-9A-F]{64}$/);
    expect(hmacSign("secret", samplePayload)).toBe(sig); // deterministic
  });

  it("hmacVerify accepts a valid signature", () => {
    const sig = hmacSign("secret", samplePayload);
    expect(hmacVerify("secret", samplePayload, sig)).toBe(true);
  });

  it("hmacVerify REJECTS a tampered message", () => {
    const sig = hmacSign("secret", samplePayload);
    const tampered = { ...samplePayload, amount: "999999" };
    expect(hmacVerify("secret", tampered, sig)).toBe(false);
  });

  it("hmacVerify rejects a wrong secret", () => {
    const sig = hmacSign("secret", samplePayload);
    expect(hmacVerify("other-secret", samplePayload, sig)).toBe(false);
  });

  it("hmacVerify rejects a malformed/short signature without throwing", () => {
    expect(hmacVerify("secret", samplePayload, "deadbeef")).toBe(false);
  });

  it("canonicalize is stable field-ordered", () => {
    expect(canonicalize(samplePayload)).toBe(
      [
        "asset=USDT",
        "amount=1000",
        "amountDecimals=6",
        "from=bg_merchant_from",
        "to=bg_merchant_to",
        "nonce=REF_X",
        "validBefore=9999999999",
        "signedAt=1700000000",
      ].join("\n")
    );
  });

  it("RealBitgetSigner.sign/verify round-trips and detects tamper", () => {
    const signer = new RealBitgetSigner({ seed: "rt" });
    const sig = signer.sign(samplePayload);
    expect(signer.verify(samplePayload, sig)).toBe(true);
    expect(signer.verify({ ...samplePayload, to: "evil" }, sig)).toBe(false);
  });
});

// ---- capabilities -----------------------------------------------------------

describe("getCapabilities", () => {
  it("reports bitget provider, USDT+USDC, cex-pay protocol, off-chain", () => {
    const { connector } = makeConnector();
    const caps = connector.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.displayName).toBe("Bitget Wallet Pay");
    expect(caps.supportedAssets.map((a) => a.symbol).sort()).toEqual([
      "USDC",
      "USDT",
    ]);
    expect(caps.supportedAssets.every((a) => a.decimals === 6)).toBe(true);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.settlesOnChain).toBe(false);
    expect(caps.requiresUserApproval).toBe(false);
  });
});

// ---- createInstrument -------------------------------------------------------

describe("createInstrument", () => {
  it("rejects empty userId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("creates an instrument whose publicHandle is the merchant id", async () => {
    const { connector, signer } = makeConnector();
    const inst = await connector.createInstrument({ userId: "u1" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(signer.merchantId);
    expect(inst.id).toMatch(/^payment-instrument-bitget-[0-9a-f]{16}$/);
  });

  it("is idempotent per userId", async () => {
    const { connector } = makeConnector();
    const a = await connector.createInstrument({ userId: "same" as UserId });
    const b = await connector.createInstrument({ userId: "same" as UserId });
    expect(a.id).toBe(b.id);
  });
});

// ---- getBalance -------------------------------------------------------------

describe("getBalance", () => {
  it("returns a Balance with atomic units for a known instrument", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "bal" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.instrumentId).toBe(inst.id);
    expect(typeof bal.money.amountAtomic).toBe("string");
    expect(() => BigInt(bal.money.amountAtomic)).not.toThrow();
    expect(bal.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.getBalance("payment-instrument-bitget-unknown" as never)
    ).rejects.toThrow(/Instrument not found/);
  });
});

// ---- signAuthorization ------------------------------------------------------

describe("signAuthorization", () => {
  it("produces a verifiable HMAC signature + encoded wire token", async () => {
    const { connector, signer } = makeConnector();
    const inst = await connector.createInstrument({ userId: "s1" as UserId });
    const req = buildRequest();
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: buildSession("s1" as UserId),
    });
    expect(signed.signature).toMatch(/^[0-9A-F]{64}$/);
    expect(signed.signer).toBe(signer.merchantId);
    expect(typeof signed.encoded).toBe("string");
    // The signature must verify against the canonical payload in extra.
    const payload = signed.extra?.["authPayload"] as BitgetAuthPayload;
    expect(signer.verify(payload, signed.signature)).toBe(true);
  });

  it("throws when protocol mismatches", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "s2" as UserId });
    await expect(
      connector.signAuthorization({
        instrumentId: inst.id,
        request: buildRequest({ protocol: "x402-v1" as ProtocolId }),
        session: buildSession("s2" as UserId),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.signAuthorization({
        instrumentId: "payment-instrument-bitget-nope" as never,
        request: buildRequest(),
        session: buildSession("s3" as UserId),
      })
    ).rejects.toThrow(/Instrument not found/);
  });
});

// ---- settle -----------------------------------------------------------------

describe("settle", () => {
  it("succeeds offline with a deterministic mock tx ref", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "set1" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("set1" as UserId),
    });
    const result = await connector.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toMatch(/^bgpay_[0-9a-f]{32}$/);
    expect(result.network).toBe("bitget-pay-sandbox");
    expect(result.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses a pluggable submit hook when provided", async () => {
    const signer = new RealBitgetSigner({
      seed: "hooked",
      submit: async () => ({ transactionRef: "REAL_TX_123", network: "bitget-pay" }),
    });
    const connector = new BitgetPayConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await connector.createInstrument({ userId: "h1" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("h1" as UserId),
    });
    const result = await connector.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("REAL_TX_123");
    expect(result.network).toBe("bitget-pay");
  });

  it("rejects a tampered signed authorization", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "t1" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: buildRequest(),
      session: buildSession("t1" as UserId),
    });
    const tampered = {
      ...signed,
      extra: {
        ...signed.extra,
        authPayload: { ...(signed.extra?.["authPayload"] as object), amount: "999999" },
      },
    };
    const result = await connector.settle(tampered);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("fails cleanly when authPayload is missing", async () => {
    const { connector } = makeConnector();
    const result = await connector.settle({
      request: buildRequest(),
      signer: "bg_merchant_x",
      signature: "DEADBEEF",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});
