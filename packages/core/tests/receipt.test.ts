/**
 * Tests for finance/receipt.ts — issueReceipt + HMAC sign/verify.
 */

import { describe, expect, it } from "vitest";
import {
  issueReceipt,
  signReceiptHmac,
  verifyReceiptHmac,
  canonicalReceiptJson,
  ReceiptError,
  type ReceiptLineItem,
} from "../src/finance/index.js";
import type { Money, SessionId, TransactionRef } from "../src/types.js";

const SESSION = "payment-session-abc" as SessionId;
const TXREF = "tx-1" as TransactionRef;

const money = (atomic: string): Money => ({
  amountAtomic: atomic,
  decimals: 6,
  currency: "USDC",
});

function lineItem(amount: string, sku = "sku-1"): ReceiptLineItem {
  return {
    sku,
    description: `${sku} description`,
    quantity: 1,
    unitPrice: money(amount),
    amount: money(amount),
  };
}

function baseInput() {
  return {
    sessionId: SESSION,
    transactionRef: TXREF,
    merchant: "did:web:merchant.example",
    lineItems: [lineItem("600000"), lineItem("400000", "sku-2")],
    network: "base-sepolia",
    total: money("1000000"),
  };
}

describe("issueReceipt", () => {
  it("builds a receipt with a urn:uuid id and ISO issuedAt", () => {
    const r = issueReceipt(baseInput());
    expect(r.id.startsWith("urn:uuid:")).toBe(true);
    expect(() => new Date(r.issuedAt).toISOString()).not.toThrow();
    expect(r.total).toEqual(money("1000000"));
    expect(r.lineItems.length).toBe(2);
  });

  it("honors an explicit issuedAt override", () => {
    const when = "2026-01-01T00:00:00.000Z";
    const r = issueReceipt({ ...baseInput(), issuedAt: when });
    expect(r.issuedAt).toBe(when);
  });

  it("carries optional metadata", () => {
    const r = issueReceipt({
      ...baseInput(),
      metadata: { orderId: "ord-42" },
    });
    expect(r.metadata?.orderId).toBe("ord-42");
  });

  it("throws total_mismatch when total != sum of line items", () => {
    try {
      issueReceipt({ ...baseInput(), total: money("999999") });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReceiptError);
      expect((err as ReceiptError).code).toBe("total_mismatch");
    }
  });

  it("throws empty_line_items when no line items", () => {
    expect(() =>
      issueReceipt({ ...baseInput(), lineItems: [], total: money("0") })
    ).toThrow(ReceiptError);
  });

  it("throws currency_mismatch when a line item currency differs", () => {
    const bad: ReceiptLineItem = {
      sku: "x",
      description: "x",
      quantity: 1,
      unitPrice: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
    };
    expect(() =>
      issueReceipt({
        ...baseInput(),
        lineItems: [bad],
        total: money("1000000"),
      })
    ).toThrow(/currency/);
  });
});

describe("signReceiptHmac / verifyReceiptHmac", () => {
  const secret = "super-secret-key";

  it("sign then verify round-trips true", () => {
    const r = issueReceipt({ ...baseInput(), issuedAt: "2026-01-01T00:00:00.000Z" });
    const signed = signReceiptHmac(r, secret);
    expect(signed.signature?.type).toBe("HMAC-SHA256");
    expect(verifyReceiptHmac(signed, secret)).toBe(true);
  });

  it("does not mutate the input receipt", () => {
    const r = issueReceipt(baseInput());
    signReceiptHmac(r, secret);
    expect(r.signature).toBe(undefined);
  });

  it("verify is false with the wrong secret", () => {
    const r = issueReceipt(baseInput());
    const signed = signReceiptHmac(r, secret);
    expect(verifyReceiptHmac(signed, "wrong-secret")).toBe(false);
  });

  it("verify is false on a tampered total", () => {
    const r = issueReceipt(baseInput());
    const signed = signReceiptHmac(r, secret);
    const tampered = { ...signed, total: money("2000000") };
    expect(verifyReceiptHmac(tampered, secret)).toBe(false);
  });

  it("verify is false when there is no signature", () => {
    const r = issueReceipt(baseInput());
    expect(verifyReceiptHmac(r, secret)).toBe(false);
  });

  it("canonical JSON is stable regardless of key order", () => {
    const r1 = issueReceipt({ ...baseInput(), issuedAt: "2026-01-01T00:00:00.000Z" });
    // Build a logically-equal receipt by re-spreading in a different order.
    const reordered = {
      total: r1.total,
      merchant: r1.merchant,
      network: r1.network,
      lineItems: r1.lineItems,
      transactionRef: r1.transactionRef,
      sessionId: r1.sessionId,
      issuedAt: r1.issuedAt,
      id: r1.id,
    } as typeof r1;
    expect(canonicalReceiptJson(reordered)).toBe(canonicalReceiptJson(r1));
  });

  it("signatures are tied to the receipt content (different totals differ)", () => {
    const a = issueReceipt({ ...baseInput(), issuedAt: "2026-01-01T00:00:00.000Z" });
    const b = issueReceipt({
      ...baseInput(),
      issuedAt: "2026-01-01T00:00:00.000Z",
      lineItems: [lineItem("1000000")],
      total: money("1000000"),
    });
    const sa = signReceiptHmac(a, secret);
    const sb = signReceiptHmac(b, secret);
    expect(sa.signature?.proofValue).not.toBe(sb.signature?.proofValue);
  });
});
