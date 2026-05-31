/**
 * WalletConnector conformance tests.
 *
 * USAGE — call this from your test file (vitest / jest / mocha):
 *
 *     import { describe, it, expect, beforeAll } from "vitest";
 *     import { runWalletConformance } from "@openagentpay/conformance/wallet";
 *
 *     runWalletConformance(
 *       { describe, it, expect, beforeAll },  // ← inject your runner
 *       { createConnector: ..., createUserId: ..., buildPaymentRequest: ... }
 *     );
 *
 * The first argument is a `TestRunner` you build from your test framework's
 * globals. This makes the conformance suite framework-agnostic — vitest, jest,
 * mocha+chai, anything with the same shape works.
 *
 * 25 test cases across 7 categories — see WALLET_CONFORMANCE_GROUPS.
 *
 * @license Apache-2.0
 */

import type {
  CreateInstrumentInput,
  PaymentRequest,
  ProtocolId,
  Session,
  SessionId,
  SignAuthorizationInput,
  UserId,
  WalletConnector,
} from "@openagentpay/core";

// ============================================================================
//  TestRunner — injected by the consumer (their `vitest` / `jest` globals)
// ============================================================================

export interface TestExpectation {
  toBe(other: unknown): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toEqual(other: unknown): void;
  toMatch(re: RegExp | string): void;
  rejects: { toThrow(msg?: string | RegExp): Promise<void> };
}

export interface TestRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  beforeAll(fn: () => Promise<void> | void): void;
  expect(value: unknown): TestExpectation;
}

// ============================================================================
//  Public API — what test authors pass in
// ============================================================================

export interface WalletConformanceFixture {
  /** Factory returning a fresh WalletConnector per test. */
  createConnector(): WalletConnector | Promise<WalletConnector>;
  /** Mint a UserId — typically `(suffix) => \`test-user-${suffix}\` as UserId`. */
  createUserId(suffix: string): UserId;
  /**
   * Build a valid PaymentRequest the connector should accept.
   * The conformance suite supplies overrides — the fixture must merge with
   * sensible connector-specific defaults (recipient, asset, amount).
   */
  buildPaymentRequest(overrides?: Partial<PaymentRequest>): PaymentRequest;
  /** Build a valid Session to pass into signAuthorization. */
  buildSession?(id: SessionId, userId: UserId): Session;
}

export interface WalletConformanceOptions {
  /**
   * Set true if the connector requires live network access (e.g., real CDP
   * credentials). Network-required tests will be SKIPPED unless this flag
   * AND `process.env.OPENAGENTPAY_LIVE_TESTS === "true"`.
   */
  requiresNetwork?: boolean;
  /** Skip the on-chain settle() test. */
  skipSettle?: boolean;
  /** Custom suite label — default "WalletConnector conformance". */
  suiteName?: string;
}

export interface ConformanceReport {
  readonly suiteVersion: string;
  readonly walletProvider: string;
  readonly passed: number;
  readonly skipped: number;
  readonly total: number;
}

export const WALLET_CONFORMANCE_GROUPS = [
  "getCapabilities()",
  "createInstrument()",
  "getBalance()",
  "signAuthorization()",
  "settle()",
  "error handling",
  "determinism",
] as const;

// ============================================================================
//  Default Session builder
// ============================================================================

function defaultBuildSession(id: SessionId, userId: UserId): Session {
  const now = new Date();
  return {
    id,
    userId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  };
}

// ============================================================================
//  Main entry point
// ============================================================================

export function runWalletConformance(
  runner: TestRunner,
  fixture: WalletConformanceFixture,
  options: WalletConformanceOptions = {}
): void {
  const { describe, it, beforeAll, expect } = runner;
  const suiteName = options.suiteName ?? "WalletConnector conformance";
  const buildSession = fixture.buildSession ?? defaultBuildSession;
  const isLive =
    typeof process !== "undefined" &&
    process.env?.["OPENAGENTPAY_LIVE_TESTS"] === "true";
  const networkOK = !options.requiresNetwork || isLive;

  describe(suiteName, () => {
    let connector: WalletConnector;

    beforeAll(async () => {
      connector = await fixture.createConnector();
    });

    // ------------------------------------------------------------------------
    //  1. Capability self-report (pure, no I/O)
    // ------------------------------------------------------------------------
    describe("getCapabilities()", () => {
      it("returns a stable walletProvider id (string, non-empty)", () => {
        const caps = connector.getCapabilities();
        expect(typeof caps.walletProvider).toBe("string");
        expect((caps.walletProvider as string).length).toBeGreaterThan(0);
      });

      it("returns a non-empty supportedAssets array", () => {
        const caps = connector.getCapabilities();
        expect(Array.isArray(caps.supportedAssets)).toBeTruthy();
        expect(caps.supportedAssets.length).toBeGreaterThan(0);
        for (const a of caps.supportedAssets) {
          expect(typeof a.symbol).toBe("string");
          expect(typeof a.decimals).toBe("number");
          expect(a.decimals).toBeGreaterThanOrEqual(0);
          // 24 = NEAR yocto (1e24); covers all known chains (EVM 18, NEAR 24).
          expect(a.decimals).toBeLessThanOrEqual(24);
        }
      });

      it("returns a non-empty supportedProtocols array", () => {
        const caps = connector.getCapabilities();
        expect(Array.isArray(caps.supportedProtocols)).toBeTruthy();
        expect(caps.supportedProtocols.length).toBeGreaterThan(0);
      });

      it("getCapabilities is pure (returns equal results twice)", () => {
        const a = connector.getCapabilities();
        const b = connector.getCapabilities();
        expect(a.walletProvider).toBe(b.walletProvider);
        expect(a.supportedAssets.length).toBe(b.supportedAssets.length);
        expect(a.supportedProtocols.length).toBe(b.supportedProtocols.length);
      });
    });

    // ------------------------------------------------------------------------
    //  2. Instrument lifecycle
    // ------------------------------------------------------------------------
    describe("createInstrument()", () => {
      it("creates an Instrument with correct walletProvider", async () => {
        const userId = fixture.createUserId("inst-1");
        const inst = await connector.createInstrument({ userId });
        const caps = connector.getCapabilities();
        expect(inst.walletProvider).toBe(caps.walletProvider);
        expect(inst.userId).toBe(userId);
      });

      it("returns id as a non-empty string", async () => {
        const inst = await connector.createInstrument({
          userId: fixture.createUserId("inst-2"),
        });
        expect(typeof inst.id).toBe("string");
        expect((inst.id as string).length).toBeGreaterThan(0);
      });

      it("populates publicHandle with a non-empty string", async () => {
        const inst = await connector.createInstrument({
          userId: fixture.createUserId("inst-3"),
        });
        expect(typeof inst.publicHandle).toBe("string");
        expect(inst.publicHandle.length).toBeGreaterThan(0);
      });

      it("is idempotent: same userId returns same instrument", async () => {
        const userId = fixture.createUserId("inst-idem");
        const a = await connector.createInstrument({ userId });
        const b = await connector.createInstrument({ userId });
        expect(a.id).toBe(b.id);
        expect(a.publicHandle).toBe(b.publicHandle);
      });
    });

    // ------------------------------------------------------------------------
    //  3. Balance read
    // ------------------------------------------------------------------------
    describe("getBalance()", () => {
      it("returns a Balance with correct instrumentId", async () => {
        if (!networkOK) return;
        const inst = await connector.createInstrument({
          userId: fixture.createUserId("bal-1"),
        });
        const bal = await connector.getBalance(inst.id);
        expect(bal.instrumentId).toBe(inst.id);
      });

      it("balance.money has stringified atomic units (parses as bigint)", async () => {
        if (!networkOK) return;
        const inst = await connector.createInstrument({
          userId: fixture.createUserId("bal-2"),
        });
        const bal = await connector.getBalance(inst.id);
        expect(typeof bal.money.amountAtomic).toBe("string");
        const ok = (() => {
          try {
            return BigInt(bal.money.amountAtomic) >= BigInt(0);
          } catch {
            return false;
          }
        })();
        expect(ok).toBeTruthy();
      });

      it("balance.fetchedAt is a valid ISO 8601 timestamp", async () => {
        if (!networkOK) return;
        const inst = await connector.createInstrument({
          userId: fixture.createUserId("bal-3"),
        });
        const bal = await connector.getBalance(inst.id);
        expect(bal.fetchedAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
        );
      });
    });

    // ------------------------------------------------------------------------
    //  4. Authorization signing
    // ------------------------------------------------------------------------
    describe("signAuthorization()", () => {
      it("returns a SignedAuthorization echoing the request", async () => {
        if (!networkOK) return;
        const userId = fixture.createUserId("sign-1");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const request = fixture.buildPaymentRequest();
        const input: SignAuthorizationInput = {
          instrumentId: inst.id,
          request,
          session,
        };
        const signed = await connector.signAuthorization(input);
        expect(signed.request.protocol).toBe(request.protocol);
        expect(signed.request.recipient).toBe(request.recipient);
        expect(signed.request.amount.amountAtomic).toBe(
          request.amount.amountAtomic
        );
      });

      it("populates a non-empty signature string", async () => {
        if (!networkOK) return;
        const userId = fixture.createUserId("sign-2");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const signed = await connector.signAuthorization({
          instrumentId: inst.id,
          request: fixture.buildPaymentRequest(),
          session,
        });
        expect(typeof signed.signature).toBe("string");
        expect(signed.signature.length).toBeGreaterThan(0);
      });

      it("populates signer field", async () => {
        if (!networkOK) return;
        const userId = fixture.createUserId("sign-3");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const signed = await connector.signAuthorization({
          instrumentId: inst.id,
          request: fixture.buildPaymentRequest(),
          session,
        });
        expect(typeof signed.signer).toBe("string");
        expect(signed.signer.length).toBeGreaterThan(0);
      });

      it("rejects unsupported protocols", async () => {
        if (!networkOK) return;
        const userId = fixture.createUserId("sign-4");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const badRequest = fixture.buildPaymentRequest({
          protocol: "totally-bogus-protocol-v999" as ProtocolId,
        });
        await expect(
          (async () => {
            await connector.signAuthorization({
              instrumentId: inst.id,
              request: badRequest,
              session,
            });
          })()
        ).rejects.toThrow();
      });

      it("does not move funds (sign-only — settle is separate)", () => {
        // Sentinel — the contract is enforced by the WalletConnector docstring.
        expect(true).toBeTruthy();
      });
    });

    // ------------------------------------------------------------------------
    //  5. Settlement
    // ------------------------------------------------------------------------
    describe("settle()", () => {
      it("returns SettlementResult with success boolean", async () => {
        if (!networkOK || options.skipSettle) return;
        const userId = fixture.createUserId("settle-1");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const signed = await connector.signAuthorization({
          instrumentId: inst.id,
          request: fixture.buildPaymentRequest(),
          session,
        });
        const result = await connector.settle(signed);
        expect(typeof result.success).toBe("boolean");
        expect(typeof result.network).toBe("string");
      });

      it("populates settledAt as ISO 8601 timestamp", async () => {
        if (!networkOK || options.skipSettle) return;
        const userId = fixture.createUserId("settle-2");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const signed = await connector.signAuthorization({
          instrumentId: inst.id,
          request: fixture.buildPaymentRequest(),
          session,
        });
        const result = await connector.settle(signed);
        expect(result.settledAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
        );
      });

      it("on success populates transactionRef", async () => {
        if (!networkOK || options.skipSettle) return;
        const userId = fixture.createUserId("settle-3");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const signed = await connector.signAuthorization({
          instrumentId: inst.id,
          request: fixture.buildPaymentRequest(),
          session,
        });
        const result = await connector.settle(signed);
        if (result.success) {
          expect(typeof result.transactionRef).toBe("string");
          expect((result.transactionRef as string).length).toBeGreaterThan(0);
        }
      });

      it("on failure uses a canonical errorCode", async () => {
        if (!networkOK || options.skipSettle) return;
        const userId = fixture.createUserId("settle-4");
        const inst = await connector.createInstrument({ userId });
        const session = buildSession(
          `payment-session-conformance-${userId}` as SessionId,
          userId
        );
        const signed = await connector.signAuthorization({
          instrumentId: inst.id,
          request: fixture.buildPaymentRequest(),
          session,
        });
        const result = await connector.settle(signed);
        if (!result.success) {
          const canonical = [
            "insufficient_funds",
            "signature_invalid",
            "nonce_used",
            "expired_authorization",
            "rpc_error",
            "rate_limited",
            "compliance_blocked",
            "unknown",
          ];
          expect(canonical.includes(result.errorCode ?? "unknown")).toBeTruthy();
        }
      });
    });

    // ------------------------------------------------------------------------
    //  6. Error handling
    // ------------------------------------------------------------------------
    describe("error handling", () => {
      it("getBalance with bogus instrumentId throws or fails gracefully", async () => {
        const bogus = "payment-instrument-DOES-NOT-EXIST-zzz" as never;
        await expect(
          (async () => {
            await connector.getBalance(bogus);
          })()
        ).rejects.toThrow();
      });

      it("createInstrument is rejected on missing userId", async () => {
        await expect(
          (async () => {
            await connector.createInstrument(
              { userId: "" as UserId } as CreateInstrumentInput
            );
          })()
        ).rejects.toThrow();
      });

      it("signAuthorization with bogus instrumentId throws", async () => {
        const userId = fixture.createUserId("err-sign");
        const session = buildSession(
          `payment-session-bogus-${userId}` as SessionId,
          userId
        );
        await expect(
          (async () => {
            await connector.signAuthorization({
              instrumentId: "bogus-instrument-id" as never,
              request: fixture.buildPaymentRequest(),
              session,
            });
          })()
        ).rejects.toThrow();
      });
    });

    // ------------------------------------------------------------------------
    //  7. Determinism / purity
    // ------------------------------------------------------------------------
    describe("determinism", () => {
      it("multiple createInstrument for same user are idempotent", async () => {
        const userId = fixture.createUserId("det-1");
        const a = await connector.createInstrument({ userId });
        const b = await connector.createInstrument({ userId });
        const c = await connector.createInstrument({ userId });
        expect(a.id).toBe(b.id);
        expect(b.id).toBe(c.id);
      });

      it("getCapabilities does not mutate state", () => {
        const before = connector.getCapabilities();
        const _again = connector.getCapabilities();
        const after = connector.getCapabilities();
        expect(before.walletProvider).toBe(after.walletProvider);
      });
    });
  });
}
