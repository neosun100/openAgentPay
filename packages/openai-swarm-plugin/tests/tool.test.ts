/**
 * OpenAI Swarm plugin tests — verify the plain-function descriptor shape Swarm
 * expects: { name, description, parameters, run(args) }.
 */

import { describe, expect, it, vi } from "vitest";
import { createSwarmPaymentTool } from "../src/index.js";
import * as llama from "@openagentpay/llamaindex-plugin";
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
          transactionRef: "0xSWARM_TX" as never,
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

describe("createSwarmPaymentTool", () => {
  it("returns Swarm-shaped descriptor { name, description, parameters, run }", () => {
    const tool = createSwarmPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.run).toBe("function");
    expect((tool.parameters as { type: string }).type).toBe("object");
    expect((tool.parameters as { required: string[] }).required).toContain("amountUsd");
  });

  it("run(args) delegates to OpenAgentPayLlamaTool.runPayment", async () => {
    const spy = vi.spyOn(llama.OpenAgentPayLlamaTool.prototype, "runPayment");
    const tool = createSwarmPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const input = { amountUsd: 0.001, recipient: "0xR", reason: "swarm test" };
    const r = await tool.run(input);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(input);
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xSWARM_TX");
    expect(r.walletProvider).toBe("test-wallet");
    spy.mockRestore();
  });

  it("parameters JSON Schema describes mandates field for AP2", () => {
    const tool = createSwarmPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props["mandates"]).toBeDefined();
    expect((props["amountUsd"] as { type: string }).type).toBe("number");
  });

  it("respects walletProvider override passed in args", async () => {
    const tool = createSwarmPaymentTool({
      manager: makeMockManager(),
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
