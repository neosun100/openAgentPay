/**
 * CrewAI Flows plugin tests — verify the @tool-style descriptor shape the
 * Flows API expects (name / description / args_schema / run).
 */

import { describe, expect, it } from "vitest";
import { createCrewAiFlowPaymentTool } from "../src/index.js";
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

function makeMockManager(): { manager: PaymentManager; processCalls: () => number } {
  let sc = 0;
  let ic = 0;
  let processCalls = 0;
  const sessions = new Map<string, Session>();
  const manager: PaymentManager = {
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
      processCalls++;
      const s = sessions.get(input.sessionId)!;
      return {
        success: true,
        settlement: {
          success: true,
          transactionRef: "0xCREWAI_FLOW_TX" as never,
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
  return { manager, processCalls: () => processCalls };
}

describe("createCrewAiFlowPaymentTool", () => {
  it("returns CrewAI-Flows-shaped descriptor (name/description/args_schema/run)", () => {
    const { manager } = makeMockManager();
    const tool = createCrewAiFlowPaymentTool({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.run).toBe("function");
    expect((tool.args_schema as { type?: string }).type).toBe("object");
    expect((tool.args_schema as { required?: string[] }).required).toContain("amountUsd");
  });

  it("run(args) delegates to runPayment (mock processPayment is hit)", async () => {
    const { manager, processCalls } = makeMockManager();
    const tool = createCrewAiFlowPaymentTool({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.run({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "crewai flows test",
    });
    expect(processCalls()).toBe(1);
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xCREWAI_FLOW_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("args_schema describes the mandates field for AP2", () => {
    const { manager } = makeMockManager();
    const tool = createCrewAiFlowPaymentTool({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (tool.args_schema as { properties: Record<string, unknown> }).properties;
    expect(props["mandates"]).toBeDefined();
    expect((props["amountUsd"] as { type?: string }).type).toBe("number");
  });

  it("respects walletProvider override in args", async () => {
    const { manager } = makeMockManager();
    const tool = createCrewAiFlowPaymentTool({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.run({
      amountUsd: 0.5,
      recipient: "0xR",
      reason: "override test",
      walletProvider: "hashkey-chain",
    });
    expect(r.success).toBe(true);
    expect(r.walletProvider).toBe("hashkey-chain");
  });
});
