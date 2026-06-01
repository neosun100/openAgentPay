import { describe, expect, it } from "vitest";
import {
  WebMonetizationProtocolAdapter,
  PROTOCOL_ID,
  X_PAYMENT_WM_HEADER,
  type Wm402Body,
} from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Wm402Body = {
  wmVersion: "1",
  paymentPointer: "$wallet.example.com/alice",
  asset: { code: "USD", scale: 9 },
  amount: { value: "1000000" },
  receiptsEnabled: true,
};

describe("WebMonetizationProtocolAdapter", () => {
  it("detects WM body", () => {
    const a = new WebMonetizationProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });

  it("rejects non-WM body (bare x402)", () => {
    const a = new WebMonetizationProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("does not detect when wmVersion present but paymentPointer missing", () => {
    const a = new WebMonetizationProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { wmVersion: "1" } })).toBe(false);
  });

  it("parses to PaymentRequest with atomic Money (scale = decimals)", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.amountAtomic).toBe("1000000");
    expect(r.amount.decimals).toBe(9);
    expect(r.amount.currency).toBe("USD");
    expect(r.asset.decimals).toBe(9);
    expect(r.protocol).toBe(PROTOCOL_ID);
  });

  it("normalizes $-pointer to https Open Payments wallet URL", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.recipient).toBe("https://wallet.example.com/alice");
  });

  it("normalizes bare $host pointer to .well-known/pay", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { ...baseBody, paymentPointer: "$wallet.example.com" },
    });
    expect(r.recipient).toBe("https://wallet.example.com/.well-known/pay");
  });

  it("accepts an https:// pointer unchanged", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { ...baseBody, paymentPointer: "https://op.example/bob" },
    });
    expect(r.recipient).toBe("https://op.example/bob");
  });

  it("uses defaultStreamAmount when amount omitted", async () => {
    const a = new WebMonetizationProtocolAdapter({ defaultStreamAmount: "500" });
    const { amount, ...rest } = baseBody;
    void amount;
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: rest });
    expect(r.amount.amountAtomic).toBe("500");
  });

  it("throws when no amount and no default configured", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const { amount, ...rest } = baseBody;
    void amount;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: rest })
    ).rejects.toThrowError(/no amount/);
  });

  it("rejects empty / malformed payment pointer", async () => {
    const a = new WebMonetizationProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { ...baseBody, paymentPointer: "" } })
    ).rejects.toThrowError(ProtocolError);
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { ...baseBody, paymentPointer: "ftp://nope" } })
    ).rejects.toThrowError(/must be https:\/\/ or start with \$/);
  });

  it("rejects untrusted pointer", async () => {
    const a = new WebMonetizationProtocolAdapter({ trustedPointers: ["$other.example/x"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/not in trusted set/);
  });

  it("rejects unsupported version", async () => {
    const a = new WebMonetizationProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { ...baseBody, wmVersion: "2" } })
    ).rejects.toThrowError(/not supported/);
  });

  it("throws on missing asset block", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const broken: Record<string, unknown> = JSON.parse(JSON.stringify(baseBody));
    delete broken["asset"];
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/asset/);
  });

  it("rejects non-integer asset.scale", async () => {
    const a = new WebMonetizationProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { ...baseBody, asset: { code: "USD", scale: 1.5 } },
      })
    ).rejects.toThrowError(/scale/);
  });

  it("buildRetry emits X-PAYMENT-WM header with pointer + signature", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000000", decimals: 9, currency: "USD" },
        recipient: "https://wallet.example.com/alice",
        asset: { symbol: "USD", decimals: 9 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "n",
        rawPayload: {},
      },
      signer: "agent",
      signature: "0xsig",
    };
    const env = await a.buildRetry(signed);
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_WM_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.wmVersion).toBe("1");
    expect(decoded.paymentPointer).toBe("https://wallet.example.com/alice");
    expect(decoded.signature).toBe("0xsig");
  });

  it("buildRetry throws when signature missing", async () => {
    const a = new WebMonetizationProtocolAdapter();
    const signed = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1", decimals: 9, currency: "USD" },
        recipient: "https://wallet.example.com/alice",
        asset: { symbol: "USD", decimals: 9 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "n",
        rawPayload: {},
      },
      signer: "agent",
      signature: "",
    } as SignedAuthorization;
    await expect(a.buildRetry(signed)).rejects.toThrowError(/requires signature/);
  });
});
