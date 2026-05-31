/**
 * Cross-protocol COMPOSITION conformance (v3).
 *
 * Where `runProtocolConformance` tests a single ProtocolAdapter in isolation,
 * `runCompositionConformance` proves the thing that actually matters for AP2:
 * that an AP2 mandate envelope correctly COMPOSES with an inner settlement
 * protocol (x402, cex-pay, solana-pay, ...).
 *
 * AP2 is an AUTHORIZATION layer, never a settlement layer. A composed AP2 402
 * carries a 3-mandate chain (Intent → Cart → Payment); the PaymentMandate's
 * `settlementProtocol` field names the INNER protocol that actually moves the
 * money. This suite asserts:
 *
 *   (a) detect() is true for each composed 402 (regardless of inner protocol);
 *   (b) parsePaymentRequired() forwards the INNER settlementProtocol verbatim
 *       as `req.protocol` (composition is transparent — the outer AP2 layer
 *       does not rewrite the inner protocol id);
 *   (c) an inner protocol NOT in `allowedSettlementProtocols` is rejected;
 *   (d) the Intent → Cart → Payment mandate chain structurally validates and
 *       is preserved end-to-end on the parsed PaymentRequest.
 *
 * USAGE:
 *
 *     import { describe, it, expect, beforeAll } from "vitest";
 *     import { runCompositionConformance } from "@openagentpay/conformance/compose";
 *
 *     runCompositionConformance(
 *       { describe, it, expect, beforeAll },
 *       {
 *         createAdapter: () => new Ap2ProtocolAdapter({ allowedSettlementProtocols: [...] }),
 *         buildComposed402: (settlementProtocol) => ({ ... }),
 *         innerProtocols: ["x402-v1", "cex-pay-v0.1", "solana-pay-v1"],
 *       }
 *     );
 *
 * @license Apache-2.0
 */

import type {
  HttpResponse402,
  Mandate,
  ProtocolAdapter,
  ProtocolId,
} from "@openagentpay/core";
import type { TestRunner } from "./wallet.js";

// ============================================================================
//  Public API
// ============================================================================

/**
 * The composing adapter under test. AP2 is the canonical case, but ANY
 * authorization-layer adapter that wraps an inner settlement protocol can be
 * driven by this suite — it only relies on the ProtocolAdapter contract plus
 * a `verifyMandateChain()` method (optional; case (d) degrades gracefully).
 */
export interface CompositionAdapter extends ProtocolAdapter {
  /**
   * Optional structural validator for the mandate chain. When present, case
   * (d) walks Intent → Cart → Payment and asserts `valid === true`. AP2's
   * `Ap2ProtocolAdapter.verifyMandateChain` satisfies this.
   */
  verifyMandateChain?(mandates: ReadonlyArray<Mandate>): Promise<{
    readonly valid: boolean;
    readonly reasons: string[];
    readonly chain: unknown;
  }>;
}

export interface CompositionConformanceFixture {
  /** Factory returning a fresh composing adapter (e.g. Ap2ProtocolAdapter). */
  createAdapter(): CompositionAdapter | Promise<CompositionAdapter>;
  /**
   * Build a composed 402 whose inner PaymentMandate.settlementProtocol equals
   * the given protocol id. The body MUST be a structurally valid AP2 envelope
   * (ap2Version + a full Intent → Cart → Payment chain).
   */
  buildComposed402(settlementProtocol: string): HttpResponse402;
  /**
   * Inner settlement protocols to exercise. Each MUST be in the adapter's
   * `allowedSettlementProtocols` (so cases a–b–d pass) — the rejection case
   * (c) uses a synthetic protocol that is guaranteed NOT in the allow-list.
   */
  innerProtocols: readonly string[];
}

export interface CompositionConformanceOptions {
  /** Custom suite label — default "Cross-protocol composition conformance". */
  suiteName?: string;
  /**
   * Inner protocol guaranteed to be OUTSIDE the allow-list, used by case (c).
   * Default: "definitely-not-allowed-v0".
   */
  disallowedProtocol?: string;
}

// ============================================================================
//  Main entry point
// ============================================================================

export function runCompositionConformance(
  runner: TestRunner,
  fixture: CompositionConformanceFixture,
  options: CompositionConformanceOptions = {}
): void {
  const { describe, it, beforeAll, expect } = runner;
  const suiteName =
    options.suiteName ?? "Cross-protocol composition conformance";
  const disallowed = options.disallowedProtocol ?? "definitely-not-allowed-v0";
  const inner = fixture.innerProtocols;

  if (inner.length === 0) {
    throw new Error(
      "runCompositionConformance: fixture.innerProtocols must be non-empty"
    );
  }

  describe(suiteName, () => {
    let adapter: CompositionAdapter;

    beforeAll(async () => {
      adapter = await fixture.createAdapter();
    });

    // ------------------------------------------------------------------------
    //  (a) detect() — composition is detectable regardless of inner protocol
    // ------------------------------------------------------------------------

    describe("(a) detect() over composed envelopes", () => {
      it("detects a composed 402 for every inner protocol", () => {
        for (const proto of inner) {
          const r = fixture.buildComposed402(proto);
          expect(adapter.detect(r)).toBeTruthy();
        }
      });

      it("detection does not depend on the inner protocol id", () => {
        // The outer AP2 marker (ap2Version) drives detect(); swapping the
        // inner settlement protocol must not flip detection on/off.
        const results = inner.map((proto) =>
          adapter.detect(fixture.buildComposed402(proto))
        );
        for (const ok of results) expect(ok).toBeTruthy();
      });
    });

    // ------------------------------------------------------------------------
    //  (b) parsePaymentRequired() — inner settlementProtocol is preserved
    // ------------------------------------------------------------------------

    describe("(b) parsePaymentRequired() preserves inner settlementProtocol", () => {
      it("forwards each inner protocol verbatim as req.protocol", async () => {
        for (const proto of inner) {
          const r = fixture.buildComposed402(proto);
          const req = await adapter.parsePaymentRequired(r);
          expect(req.protocol).toBe(proto as ProtocolId);
        }
      });

      it("does NOT rewrite the inner protocol to the outer adapter id", async () => {
        // Composition must be transparent: AP2 ('ap2-v0.1') wraps the inner
        // protocol but never masquerades the parsed request as its own id.
        for (const proto of inner) {
          const req = await adapter.parsePaymentRequired(
            fixture.buildComposed402(proto)
          );
          expect(req.protocol === (adapter.id as ProtocolId)).toBeFalsy();
        }
      });

      it("carries the mandate chain through onto the PaymentRequest", async () => {
        for (const proto of inner) {
          const req = await adapter.parsePaymentRequired(
            fixture.buildComposed402(proto)
          );
          expect(Array.isArray(req.mandates)).toBeTruthy();
          expect((req.mandates ?? []).length).toBeGreaterThanOrEqual(2);
        }
      });

      it("populates settlement-layer fields (amount/recipient/nonce)", async () => {
        const req = await adapter.parsePaymentRequired(
          fixture.buildComposed402(inner[0]!)
        );
        expect(typeof req.amount.amountAtomic).toBe("string");
        expect(typeof req.amount.currency).toBe("string");
        expect(typeof req.recipient).toBe("string");
        expect(req.recipient.length).toBeGreaterThan(0);
        expect(typeof req.nonce).toBe("string");
        expect(req.nonce.length).toBeGreaterThan(0);
      });

      it("amountAtomic parses as a bigint across inner protocols", async () => {
        for (const proto of inner) {
          const req = await adapter.parsePaymentRequired(
            fixture.buildComposed402(proto)
          );
          const ok = (() => {
            try {
              BigInt(req.amount.amountAtomic);
              return true;
            } catch {
              return false;
            }
          })();
          expect(ok).toBeTruthy();
        }
      });
    });

    // ------------------------------------------------------------------------
    //  (c) allow-list — an inner protocol outside the allow-list is rejected
    // ------------------------------------------------------------------------

    describe("(c) rejects inner protocols outside the allow-list", () => {
      it("throws when the composed inner protocol is not allowed", async () => {
        const r = fixture.buildComposed402(disallowed);
        await expect(
          (async () => {
            await adapter.parsePaymentRequired(r);
          })()
        ).rejects.toThrow();
      });

      it("the rejection is specific to the allow-list (mentions allow)", async () => {
        const r = fixture.buildComposed402(disallowed);
        await expect(
          (async () => {
            await adapter.parsePaymentRequired(r);
          })()
        ).rejects.toThrow(/allow/i);
      });

      it("still ACCEPTS allowed inner protocols (allow-list is not all-deny)", async () => {
        // Guards against a fixture/adapter that rejects everything.
        const req = await adapter.parsePaymentRequired(
          fixture.buildComposed402(inner[0]!)
        );
        expect(req.protocol).toBe(inner[0]! as ProtocolId);
      });
    });

    // ------------------------------------------------------------------------
    //  (d) mandate chain — Intent → Cart → Payment structurally validates
    // ------------------------------------------------------------------------

    describe("(d) Intent → Cart → Payment chain structurally validates", () => {
      it("a composed envelope's mandate chain validates", async () => {
        const req = await adapter.parsePaymentRequired(
          fixture.buildComposed402(inner[0]!)
        );
        const mandates = req.mandates ?? [];
        if (typeof adapter.verifyMandateChain === "function") {
          const result = await adapter.verifyMandateChain(mandates);
          expect(result.valid).toBeTruthy();
          expect(result.reasons).toEqual([]);
        } else {
          // No structural validator exposed — fall back to a shape assertion
          // so the case still proves the chain survived composition.
          expect(mandates.length).toBeGreaterThanOrEqual(2);
        }
      });

      it("the chain contains a Cart and a Payment mandate", async () => {
        const req = await adapter.parsePaymentRequired(
          fixture.buildComposed402(inner[0]!)
        );
        const kinds = (req.mandates ?? []).map((m) => m.type[1]);
        expect(kinds.includes("ap2.CartMandate")).toBeTruthy();
        expect(kinds.includes("ap2.PaymentMandate")).toBeTruthy();
      });

      it("the chain validates identically for every allowed inner protocol", async () => {
        for (const proto of inner) {
          const req = await adapter.parsePaymentRequired(
            fixture.buildComposed402(proto)
          );
          const mandates = req.mandates ?? [];
          if (typeof adapter.verifyMandateChain === "function") {
            const result = await adapter.verifyMandateChain(mandates);
            expect(result.valid).toBeTruthy();
          } else {
            expect(mandates.length).toBeGreaterThanOrEqual(2);
          }
        }
      });
    });
  });
}
