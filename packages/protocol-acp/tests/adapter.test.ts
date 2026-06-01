import { describe, expect, it } from "vitest";
import {
  AcpProtocolAdapter,
  PROTOCOL_ID,
  X_PAYMENT_ACP_HEADER,
  type Acp402Body,
} from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Acp402Body = {
  acpVersion: "0.1",
  checkoutSessionId: "cs_acp_001",
  merchant: { id: "stripe_acct_001", name: "Example Store" },
  lineItems: [
    { name: "Widget", quantity: 2, unitAmount: { value: "500", currency: "USDC", decimals: 6 } },
  ],
  total: { value: "1000", currency: "USDC", decimals: 6 },
  settlement: { rail: "stablecoin", recipient: "0xMerchantWallet" },
  expiresAt: 9_999_999_999,
};

function resp(body: unknown) {
  return { statusCode: 402 as const, headers: {}, body };
}

describe("AcpProtocolAdapter", () => {
  it("detects ACP checkout-session body", () => {
    const a = new AcpProtocolAdapter();
    expect(a.detect(resp(baseBody))).toBe(true);
  });

  it("rejects non-ACP body (bare x402)", () => {
    const a = new AcpProtocolAdapter();
    expect(a.detect(resp({ x402Version: 1, accepts: [] }))).toBe(false);
  });

  it("rejects body missing checkoutSessionId in detect()", () => {
    const a = new AcpProtocolAdapter();
    const { checkoutSessionId, ...rest } = baseBody;
    void checkoutSessionId;
    expect(a.detect(resp(rest))).toBe(false);
  });

  it("parses to PaymentRequest with atomic Money + total mapped", async () => {
    const a = new AcpProtocolAdapter();
    const r = await a.parsePaymentRequired(resp(baseBody));
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.amount.amountAtomic).toBe("1000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(6);
    expect(r.recipient).toBe("0xMerchantWallet");
    expect(r.validBefore).toBe(9_999_999_999);
    expect((r.rawPayload as { acp: Acp402Body }).acp.checkoutSessionId).toBe("cs_acp_001");
  });

  it("falls back to merchant.id when no settlement.recipient", async () => {
    const a = new AcpProtocolAdapter();
    const body: Acp402Body = { ...baseBody, settlement: { rail: "card" } };
    const r = await a.parsePaymentRequired(resp(body));
    expect(r.recipient).toBe("stripe_acct_001");
  });

  it("throws ProtocolError on malformed body (not an object)", async () => {
    const a = new AcpProtocolAdapter();
    await expect(a.parsePaymentRequired(resp("nope"))).rejects.toThrowError(ProtocolError);
  });

  it("rejects empty line items", async () => {
    const a = new AcpProtocolAdapter();
    const body = { ...baseBody, lineItems: [], total: { value: "0", currency: "USDC", decimals: 6 } };
    await expect(a.parsePaymentRequired(resp(body))).rejects.toThrowError(/no line items/);
  });

  it("rejects expired checkout session via injected now()", async () => {
    const a = new AcpProtocolAdapter({ now: () => 10_000_000_000_000 });
    const body: Acp402Body = { ...baseBody, expiresAt: 1_000 };
    await expect(a.parsePaymentRequired(resp(body))).rejects.toThrowError(/expired/);
  });

  it("rejects total mismatch vs sum(lineItems)", async () => {
    const a = new AcpProtocolAdapter();
    const body: Acp402Body = { ...baseBody, total: { value: "999", currency: "USDC", decimals: 6 } };
    await expect(a.parsePaymentRequired(resp(body))).rejects.toThrowError(/!= sum of line items/);
  });

  it("accepts total mismatch when verifyTotal=false", async () => {
    const a = new AcpProtocolAdapter({ verifyTotal: false });
    const body: Acp402Body = { ...baseBody, total: { value: "777", currency: "USDC", decimals: 6 } };
    const r = await a.parsePaymentRequired(resp(body));
    expect(r.amount.amountAtomic).toBe("777");
  });

  it("rejects rail not in preferred rails", async () => {
    const a = new AcpProtocolAdapter({ preferredRails: ["card"] });
    await expect(a.parsePaymentRequired(resp(baseBody))).rejects.toThrowError(/preferred rails/);
  });

  it("rejects untrusted merchant", async () => {
    const a = new AcpProtocolAdapter({ trustedMerchants: ["other"] });
    await expect(a.parsePaymentRequired(resp(baseBody))).rejects.toThrowError(/not trusted/);
  });

  it("rejects unsupported version", async () => {
    const a = new AcpProtocolAdapter();
    await expect(
      a.parsePaymentRequired(resp({ ...baseBody, acpVersion: "9.9" }))
    ).rejects.toThrowError(ProtocolError);
  });

  it("buildRetry emits X-PAYMENT-ACP envelope with confirmed session id", async () => {
    const a = new AcpProtocolAdapter();
    const req = await a.parsePaymentRequired(resp(baseBody));
    const signed: SignedAuthorization = { request: req, signer: "agent", signature: "0xsig" };
    const env = await a.buildRetry(signed);
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_ACP_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.acpVersion).toBe("0.1");
    expect(decoded.checkoutSessionId).toBe("cs_acp_001");
    expect(decoded.signature).toBe("0xsig");
  });

  it("buildRetry throws when signature missing", async () => {
    const a = new AcpProtocolAdapter();
    const req = await a.parsePaymentRequired(resp(baseBody));
    const signed = { request: req, signer: "agent", signature: "" } as SignedAuthorization;
    await expect(a.buildRetry(signed)).rejects.toThrowError(/requires signature/);
  });
});
