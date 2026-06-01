import { describe, expect, it } from "vitest";
import {
  GnapProtocolAdapter,
  PROTOCOL_ID,
  X_PAYMENT_GNAP_HEADER,
  GNAP_VERSION,
  type Gnap402Body,
} from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Gnap402Body = {
  gnapVersion: "1",
  grantEndpoint: "https://as.example/grant",
  accessToken: { value: "gnap_tok_abc", manage: "https://as.example/token/abc" },
  access: [
    {
      type: "payment",
      actions: ["pay", "refund"],
      amount: { value: "1000", currency: "USDC", decimals: 6 },
      recipient: "0x000000000000000000000000000000000000dEaD",
    },
  ],
  interact: { redirect: "https://as.example/interact/xyz" },
};

function signedFrom(body: Gnap402Body): SignedAuthorization {
  return {
    request: {
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0x" + "1".repeat(64),
      rawPayload: { gnap: body },
    },
    signer: "agent",
    signature: "0xsig",
  };
}

describe("GnapProtocolAdapter", () => {
  it("detects a GNAP payment grant body", () => {
    const a = new GnapProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });

  it("rejects a non-GNAP body (bare x402)", () => {
    const a = new GnapProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1, accepts: [] } })).toBe(
      false
    );
  });

  it("rejects a GNAP body with no payment-type access entry (detect)", () => {
    const a = new GnapProtocolAdapter();
    const noPayment: Gnap402Body = {
      ...baseBody,
      access: [
        { type: "data", actions: ["read"], amount: { value: "0", currency: "USDC", decimals: 6 } },
      ],
    };
    expect(a.detect({ statusCode: 402, headers: {}, body: noPayment })).toBe(false);
  });

  it("parses the payment access entry to a PaymentRequest with atomic Money", async () => {
    const a = new GnapProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.amount.amountAtomic).toBe("1000");
    expect(r.amount.decimals).toBe(6);
    expect(r.amount.currency).toBe("USDC");
    expect(r.recipient).toBe("0x000000000000000000000000000000000000dEaD");
    expect(r.asset.symbol).toBe("USDC");
  });

  it("falls back recipient to grantEndpoint when access.recipient absent", async () => {
    const a = new GnapProtocolAdapter();
    const noRecipient: Gnap402Body = {
      ...baseBody,
      access: [
        { type: "payment", actions: ["pay"], amount: { value: "500", currency: "USDC", decimals: 6 } },
      ],
    };
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: noRecipient });
    expect(r.recipient).toBe("https://as.example/grant");
  });

  it("rejects when no payment-type access entry exists (parse)", async () => {
    const a = new GnapProtocolAdapter();
    // detect would skip this, but parse must defensively reject too.
    const noPayment: any = {
      gnapVersion: "1",
      grantEndpoint: "https://as.example/grant",
      access: [
        { type: "data", actions: ["read"], amount: { value: "0", currency: "USDC", decimals: 6 } },
      ],
    };
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: noPayment })
    ).rejects.toThrowError(/no payment-type access entry/);
  });

  it("throws ProtocolError on malformed body (missing grantEndpoint)", async () => {
    const a = new GnapProtocolAdapter();
    const broken: any = JSON.parse(JSON.stringify(baseBody));
    delete broken.grantEndpoint;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(ProtocolError);
  });

  it("throws on empty access[] array", async () => {
    const a = new GnapProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { ...baseBody, access: [] } })
    ).rejects.toThrowError(/non-empty/);
  });

  it("rejects unsupported GNAP version", async () => {
    const a = new GnapProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { ...baseBody, gnapVersion: "9" } })
    ).rejects.toThrowError(/not supported/);
  });

  it("rejects untrusted grant endpoint when pinned", async () => {
    const a = new GnapProtocolAdapter({ trustedGrantEndpoints: ["https://other.example/grant"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/not trusted/);
  });

  it("rejects when access actions not in allowedActions", async () => {
    const a = new GnapProtocolAdapter({ allowedActions: ["refund"] });
    const payOnly: Gnap402Body = {
      ...baseBody,
      access: [
        { type: "payment", actions: ["pay"], amount: { value: "1000", currency: "USDC", decimals: 6 } },
      ],
    };
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: payOnly })
    ).rejects.toThrowError(/allowed actions/);
  });

  it("buildRetry emits X-PAYMENT-GNAP header carrying token + signature", async () => {
    const a = new GnapProtocolAdapter();
    const env = await a.buildRetry(signedFrom(baseBody));
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_GNAP_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.gnapVersion).toBe(GNAP_VERSION);
    expect(decoded.signature).toBe("0xsig");
    expect(decoded.accessToken).toBe("gnap_tok_abc");
  });

  it("buildRetry tolerates absent access token (carries null)", async () => {
    const a = new GnapProtocolAdapter();
    const noToken: Gnap402Body = {
      gnapVersion: "1",
      grantEndpoint: "https://as.example/grant",
      access: [
        { type: "payment", actions: ["pay"], amount: { value: "1000", currency: "USDC", decimals: 6 } },
      ],
    };
    const env = await a.buildRetry(signedFrom(noToken));
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_GNAP_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.accessToken).toBeNull();
  });

  it("buildRetry throws without a signature", async () => {
    const a = new GnapProtocolAdapter();
    const bad = { ...signedFrom(baseBody), signature: "" };
    await expect(a.buildRetry(bad)).rejects.toThrowError(/requires signature/);
  });
});
