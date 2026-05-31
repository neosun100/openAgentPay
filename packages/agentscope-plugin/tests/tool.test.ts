/**
 * AgentScope plugin tests — verify the ServiceToolkit descriptor shape and
 * that `call` delegates to the kernel's runPayment and wraps a ServiceResponse.
 */

import { describe, expect, it } from "vitest";
import { createAgentScopePaymentTool } from "../src/index.js";
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

function makeMockManager(opts: { fail?: boolean } = {}): PaymentManager {
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
      if (opts.fail) {
        return {
          success: false,
          settlement: {
            success: false,
            network: "mock",
            settledAt: new Date().toISOString(),
            errorCode: "settlement_failed",
            errorMessage: "mock failure",
          },
          signed: undefined as never,
          sessionAfter: s,
        };
      }
      return {
        success: true,
        settlement: {
          success: true,
          transactionRef: "0xAGENTSCOPE_TX" as never,
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

describe("createAgentScopePaymentTool", () => {
  it("returns an AgentScope ServiceToolkit-shaped descriptor", () => {
    const tool = createAgentScopePaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.call).toBe("function");
    expect(typeof tool.description).toBe("string");
    expect((tool.parameters as Record<string, unknown>)["type"]).toBe("object");
    expect((tool.parameters as { required: string[] }).required).toContain("amountUsd");
  });

  it("call(args) delegates to runPayment and wraps a success ServiceResponse", async () => {
    const tool = createAgentScopePaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.call({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "agentscope test",
    });
    expect(r.status).toBe("success");
    expect(r.content.success).toBe(true);
    expect(r.content.txHash).toBe("0xAGENTSCOPE_TX");
    expect(r.content.walletProvider).toBe("test-wallet");
  });

  it("wraps an error ServiceResponse when settlement fails", async () => {
    const tool = createAgentScopePaymentTool({
      manager: makeMockManager({ fail: true }),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.call({
      amountUsd: 0.5,
      recipient: "0xR",
      reason: "fail test",
    });
    expect(r.status).toBe("error");
    expect(r.content.success).toBe(false);
    expect(r.content.errorCode).toBe("settlement_failed");
  });

  it("parameters JSON Schema describes the mandates field for AP2", () => {
    const tool = createAgentScopePaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props["mandates"]).toBeDefined();
    expect((props["amountUsd"] as { type: string }).type).toBe("number");
  });

  it("respects walletProvider override in args", async () => {
    const tool = createAgentScopePaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.call({
      amountUsd: 0.5,
      recipient: "0xR",
      reason: "override test",
      walletProvider: "hashkey-chain",
    });
    expect(r.status).toBe("success");
    expect(r.content.walletProvider).toBe("hashkey-chain");
  });
});
