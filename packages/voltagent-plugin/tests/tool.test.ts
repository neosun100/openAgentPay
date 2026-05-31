/**
 * VoltAgent plugin tests — verify the descriptor shape VoltAgent expects
 * (createTool: { name, description, parameters, execute(args) }).
 */

import { describe, expect, it } from "vitest";
import { createVoltAgentPaymentTool } from "../src/index.js";
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
          transactionRef: "0xVOLT_TX" as any,
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

describe("createVoltAgentPaymentTool", () => {
  it("returns VoltAgent-shaped descriptor", () => {
    const tool = createVoltAgentPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.execute).toBe("function");
    expect((tool.parameters as any).type).toBe("object");
    expect((tool.parameters as any).required).toContain("amountUsd");
  });

  it("execute(args) delegates to runPayment", async () => {
    const tool = createVoltAgentPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.execute({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "voltagent test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xVOLT_TX");
    expect(r.recipient).toBe("0xR");
  });

  it("parameters schema describes mandates field for AP2", () => {
    const tool = createVoltAgentPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect((tool.parameters as any).properties.mandates).toBeDefined();
    expect((tool.parameters as any).properties.amountUsd.type).toBe("number");
  });
});
