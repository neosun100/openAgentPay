/**
 * Receipt issuance & HMAC signing
 * ================================
 *
 * Productizes the `Receipt` / `ReceiptLineItem` / `ReceiptSignature` types into
 * runtime helpers:
 *
 *   issueReceipt      → build a Receipt, validate total == Σ lineItems.amount
 *   signReceiptHmac   → attach an HMAC-SHA256 signature over canonical JSON
 *   verifyReceiptHmac → recompute + constant-time compare
 *
 * Totals are summed with BigInt over the atomic-string representation — a
 * mismatch throws (we structurally prevent silent under/over-charging).
 *
 * @license Apache-2.0
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Receipt, ReceiptLineItem, ReceiptSignature } from "./types.js";
import type { Money, SessionId, TransactionRef } from "../types.js";

// ============================================================================
//  Errors
// ============================================================================

export class ReceiptError extends Error {
  override readonly name = "ReceiptError";
  constructor(
    message: string,
    public readonly code:
      | "total_mismatch"
      | "currency_mismatch"
      | "empty_line_items"
      | "missing_signature"
      | "internal"
  ) {
    super(message);
  }
}

// ============================================================================
//  issueReceipt
// ============================================================================

export interface IssueReceiptInput {
  readonly sessionId: SessionId;
  readonly transactionRef: TransactionRef;
  readonly merchant: string;
  readonly lineItems: ReadonlyArray<ReceiptLineItem>;
  readonly network: string;
  readonly total: Money;
  readonly metadata?: Record<string, string>;
  /** Override issuance time (defaults to Date.now). Mostly for tests. */
  readonly issuedAt?: string;
}

/**
 * Build a {@link Receipt}, validating that `total` equals the sum of
 * `lineItems.amount` (BigInt, same currency). Generates a `urn:uuid:` id.
 *
 * @throws {ReceiptError} on empty line items, currency mismatch, or total mismatch.
 */
export function issueReceipt(input: IssueReceiptInput): Receipt {
  if (input.lineItems.length === 0) {
    throw new ReceiptError(
      "receipt must have at least one line item",
      "empty_line_items"
    );
  }

  let sum = 0n;
  for (const li of input.lineItems) {
    if (li.amount.currency !== input.total.currency) {
      throw new ReceiptError(
        `line item currency ${li.amount.currency} != total currency ${input.total.currency}`,
        "currency_mismatch"
      );
    }
    if (li.amount.decimals !== input.total.decimals) {
      throw new ReceiptError(
        `line item decimals ${li.amount.decimals} != total decimals ${input.total.decimals}`,
        "currency_mismatch"
      );
    }
    sum += BigInt(li.amount.amountAtomic);
  }

  const declared = BigInt(input.total.amountAtomic);
  if (sum !== declared) {
    throw new ReceiptError(
      `total ${declared} != sum of line items ${sum}`,
      "total_mismatch"
    );
  }

  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const receipt: Receipt = {
    id: `urn:uuid:${randomUUID()}`,
    sessionId: input.sessionId,
    transactionRef: input.transactionRef,
    issuedAt,
    merchant: input.merchant,
    lineItems: input.lineItems,
    total: input.total,
    network: input.network,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
  return receipt;
}

// ============================================================================
//  Canonical serialization (stable key order, signature excluded)
// ============================================================================

/**
 * Deterministic JSON of a Receipt with the `signature` field omitted — object
 * keys are recursively sorted so the same logical receipt always produces the
 * same bytes regardless of construction order.
 */
export function canonicalReceiptJson(receipt: Receipt): string {
  const { signature: _signature, ...rest } = receipt;
  void _signature;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`
  );
  return `{${parts.join(",")}}`;
}

// ============================================================================
//  HMAC sign / verify
// ============================================================================

const HMAC_VERIFICATION_METHOD = "openagentpay:hmac";

/**
 * Attach an `HMAC-SHA256` {@link ReceiptSignature} over the canonical JSON.
 * Returns a NEW receipt — the input is not mutated.
 */
export function signReceiptHmac(
  receipt: Receipt,
  secret: string,
  options?: { readonly created?: string; readonly verificationMethod?: string }
): Receipt {
  const proofValue = createHmac("sha256", secret)
    .update(canonicalReceiptJson(receipt))
    .digest("hex");
  const signature: ReceiptSignature = {
    type: "HMAC-SHA256",
    created: options?.created ?? new Date().toISOString(),
    verificationMethod: options?.verificationMethod ?? HMAC_VERIFICATION_METHOD,
    proofValue,
  };
  return { ...receipt, signature };
}

/**
 * Verify an `HMAC-SHA256` receipt signature. Returns false if there is no
 * signature, the suite is wrong, or the recomputed digest differs. Uses a
 * constant-time comparison to avoid timing side channels.
 */
export function verifyReceiptHmac(receipt: Receipt, secret: string): boolean {
  const sig = receipt.signature;
  if (!sig || sig.type !== "HMAC-SHA256") return false;
  const expected = createHmac("sha256", secret)
    .update(canonicalReceiptJson(receipt))
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig.proofValue, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
