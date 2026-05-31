/**
 * Atomic Agents plugin tests — verify the schema-first descriptor shape.
 */

import { describe, expect, it, vi } from "vitest";
import { createAtomicPaymentTool } from "../src/index.js";
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
          transactionRef: "0xATOMIC_TX" as never,
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

describe("createAtomicPaymentTool", () => {
  it("returns an Atomic Agents-shaped descriptor", () => {
    const tool = createAtomicPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.run).toBe("function");
    expect((tool.input_schema as { type: string }).type).toBe("object");
  });

  it("run(args) delegates to runPayment", async () => {
    const mgr = makeMockManager();
    const spy = vi.spyOn(mgr, "processPayment");
    const tool = createAtomicPaymentTool({
      manager: mgr,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.run({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "atomic test",
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xATOMIC_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("input_schema declares the AP2 mandates field", () => {
    const tool = createAtomicPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (tool.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props["mandates"]).toBeDefined();
    const required = (tool.input_schema as { required: string[] }).required;
    expect(required).toContain("amountUsd");
    expect(required).toContain("recipient");
    expect(required).toContain("reason");
  });

  it("honors a per-call walletProvider override", async () => {
    const tool = createAtomicPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.run({
      amountUsd: 0.002,
      recipient: "0xR",
      reason: "override test",
      walletProvider: "solana",
    });
    expect(r.success).toBe(true);
    expect(r.walletProvider).toBe("solana");
  });
});
