/**
 * Marvin plugin tests — verify the ai_fn descriptor shape.
 */

import { describe, expect, it, vi } from "vitest";
import { createMarvinPaymentFn } from "../src/index.js";
import type {
  PaymentManager,
  Session,
  SessionId,
  Instrument,
  InstrumentId,
  CreateSessionInput,
  CreateInstrumentInput,
  WalletConnector,
  WalletProviderId,
  UserId,
} from "@openagentpay/core";

function makeMockManager(): PaymentManager {
  let sc = 0,
    ic = 0;
  const sessions = new Map<string, Session>();
  return {
    async createPaymentSession(input: CreateSessionInput): Promise<Session> {
      sc++;
      const id = `payment-session-${sc}` as SessionId;
      const s: Session = {
        id,
        userId: input.userId,
        budget: {
          amountAtomic: BigInt(Math.round(input.budgetUsd * 1e6)).toString(),
          decimals: 6,
          currency: "USDC",
        },
        spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
        expiresAt: new Date(Date.now() + input.expiresMinutes * 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
      };
      sessions.set(id, s);
      return s;
    },
    async createPaymentInstrument(
      provider: WalletProviderId,
      input: CreateInstrumentInput
    ): Promise<Instrument> {
      ic++;
      return {
        id: `payment-instrument-${ic}` as InstrumentId,
        userId: input.userId,
        walletProvider: provider,
        publicHandle: "0xagent",
        createdAt: new Date().toISOString(),
      };
    },
    async getPaymentSession(id) {
      return sessions.get(id);
    },
    async processPayment(input) {
      const s = sessions.get(input.sessionId)!;
      return {
        success: true,
        settlement: {
          success: true,
          transactionRef: "0xMARVIN_TX" as never,
          network: "mock",
          settledAt: new Date().toISOString(),
        },
        signed: undefined as never,
        sessionAfter: s,
      };
    },
    registerConnector(_: WalletConnector) {},
    getConnector() {
      return undefined;
    },
    listProviders() {
      return ["test-wallet" as WalletProviderId];
    },
  };
}

describe("createMarvinPaymentFn", () => {
  it("returns a Marvin ai_fn-shaped descriptor", () => {
    const f = createMarvinPaymentFn({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(f.name).toBe("openagentpay_pay");
    expect(typeof f.description).toBe("string");
    expect(typeof f.fn).toBe("function");
    expect((f.parameters as { type: string }).type).toBe("object");
  });

  it("fn(args) delegates to runPayment", async () => {
    const mgr = makeMockManager();
    const spy = vi.spyOn(mgr, "processPayment");
    const f = createMarvinPaymentFn({
      manager: mgr,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await f.fn({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "marvin test",
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xMARVIN_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("parameters schema declares the AP2 mandates field", () => {
    const f = createMarvinPaymentFn({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (f.parameters as { properties: Record<string, unknown> }).properties;
    expect(props["mandates"]).toBeDefined();
    const required = (f.parameters as { required: string[] }).required;
    expect(required).toContain("amountUsd");
    expect(required).toContain("recipient");
    expect(required).toContain("reason");
  });

  it("honors a per-call walletProvider override", async () => {
    const f = createMarvinPaymentFn({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await f.fn({
      amountUsd: 0.002,
      recipient: "0xR",
      reason: "override test",
      walletProvider: "coinbase-cdp",
    });
    expect(r.success).toBe(true);
    expect(r.walletProvider).toBe("coinbase-cdp");
  });
});
