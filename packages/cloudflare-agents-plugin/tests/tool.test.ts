/**
 * Cloudflare Agents plugin tests — verify the descriptor shape the Agents
 * SDK's tool() helper expects, and that execute() delegates to runPayment().
 */

import { describe, expect, it } from "vitest";
import { createCloudflareAgentsPaymentTool } from "../src/index.js";
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
          transactionRef: "0xCF_TX" as any,
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

describe("createCloudflareAgentsPaymentTool", () => {
  it("returns Cloudflare-Agents-shaped descriptor", () => {
    const tool = createCloudflareAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.description).toBe("string");
    expect((tool.parameters as any).type).toBe("object");
    expect((tool.parameters as any).required).toContain("amountUsd");
    // Agents SDK tools have no `name`/`id` field — only description/parameters/execute.
    expect("name" in tool).toBe(false);
  });

  it("execute(args) delegates to runPayment", async () => {
    const tool = createCloudflareAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.execute({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "cloudflare agents test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xCF_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("parameters JSON Schema describes mandates field for AP2", () => {
    const tool = createCloudflareAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect((tool.parameters as any).properties.mandates).toBeDefined();
    expect((tool.parameters as any).properties.amountUsd.type).toBe("number");
  });

  it("respects walletProvider override in args", async () => {
    const tool = createCloudflareAgentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.execute({
      amountUsd: 0.5,
      recipient: "0xR",
      reason: "override test",
      walletProvider: "hashkey-chain",
    });
    expect(r.success).toBe(true);
    expect(r.walletProvider).toBe("hashkey-chain");
  });
});
