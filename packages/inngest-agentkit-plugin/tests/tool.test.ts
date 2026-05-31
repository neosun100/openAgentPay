/**
 * Inngest AgentKit plugin tests — verify the descriptor shape AgentKit expects.
 */

import { describe, expect, it, vi } from "vitest";
import { createInngestPaymentTool } from "../src/index.js";
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
          transactionRef: "0xINNGEST_TX" as never,
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

describe("createInngestPaymentTool", () => {
  it("returns an AgentKit-shaped descriptor", () => {
    const tool = createInngestPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.handler).toBe("function");
    expect((tool.parameters as { type: string }).type).toBe("object");
  });

  it("handler(args) delegates to runPayment", async () => {
    const mgr = makeMockManager();
    const spy = vi.spyOn(mgr, "processPayment");
    const tool = createInngestPaymentTool({
      manager: mgr,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.handler({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "inngest test",
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xINNGEST_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("parameters schema declares the AP2 mandates field", () => {
    const tool = createInngestPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props["mandates"]).toBeDefined();
    const required = (tool.parameters as { required: string[] }).required;
    expect(required).toContain("amountUsd");
    expect(required).toContain("recipient");
    expect(required).toContain("reason");
  });

  it("honors a per-call walletProvider override", async () => {
    const tool = createInngestPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.handler({
      amountUsd: 0.002,
      recipient: "0xR",
      reason: "override test",
      walletProvider: "hashkey-chain",
    });
    expect(r.success).toBe(true);
    expect(r.walletProvider).toBe("hashkey-chain");
  });
});
