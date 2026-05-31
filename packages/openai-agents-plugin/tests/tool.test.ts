/**
 * OpenAI Agents plugin tests — verify the function-tool descriptor shape the
 * OpenAI Agents SDK expects and that invoke/execute delegate to runPayment.
 */

import { describe, expect, it } from "vitest";
import { createOpenAIAgentsPaymentTool } from "../src/index.js";
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
    async createPaymentInstrument(_p, input: CreateInstrumentInput): Promise<Instrument> {
      ic++;
      return {
        id: `payment-instrument-${ic}` as InstrumentId,
        userId: input.userId,
        walletProvider: "test-wallet" as WalletProviderId,
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
          transactionRef: "0xOPENAI_AGENTS_TX" as any,
          network: "mock",
          settledAt: new Date().toISOString(),
        },
        signed: undefined as any,
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

describe("createOpenAIAgentsPaymentTool", () => {
  it("returns OpenAI-Agents-shaped function-tool descriptor", () => {
    const tool = createOpenAIAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.type).toBe("function");
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.invoke).toBe("function");
    expect(typeof tool.execute).toBe("function");
    expect((tool.parameters as any).type).toBe("object");
    expect((tool.parameters as any).required).toContain("amountUsd");
  });

  it("invoke(args) delegates to runPayment", async () => {
    const tool = createOpenAIAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.invoke({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "openai-agents invoke test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xOPENAI_AGENTS_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("execute is an alias that also runs the payment", async () => {
    const tool = createOpenAIAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.execute({
      amountUsd: 0.5,
      recipient: "0xMerchant",
      reason: "openai-agents execute test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xOPENAI_AGENTS_TX");
    expect(r.hadMandates).toBe(false);
  });

  it("parameters schema describes the mandates field for AP2", () => {
    const tool = createOpenAIAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect((tool.parameters as any).properties.mandates).toBeDefined();
    expect((tool.parameters as any).properties.mandates.type).toBe("array");
  });
});
