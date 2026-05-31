/**
 * smolagents plugin tests — verify the descriptor shape smolagents expects.
 */

import { describe, expect, it, vi } from "vitest";
import { createSmolagentsPaymentTool } from "../src/index.js";
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
      _p,
      input: CreateInstrumentInput
    ): Promise<Instrument> {
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
          transactionRef: "0xSMOL_TX" as any,
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

describe("createSmolagentsPaymentTool", () => {
  it("returns smolagents-shaped descriptor", () => {
    const tool = createSmolagentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(tool.outputType).toBe("string");
    expect(typeof tool.forward).toBe("function");
    expect(tool.inputs.amountUsd?.type).toBe("number");
    expect(tool.inputs.recipient?.type).toBe("string");
    expect(typeof tool.description).toBe("string");
  });

  it("forward(args) delegates to runPayment", async () => {
    const tool = createSmolagentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.forward({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "smolagents test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xSMOL_TX");
    expect(r.recipient).toBe("0xR");
  });

  it("inputs describe the AP2 mandates field", () => {
    const tool = createSmolagentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.inputs.mandates).toBeDefined();
    expect(tool.inputs.mandates?.nullable).toBe(true);
  });

  it("forward routes args straight through to the kernel (spy)", async () => {
    const tool = createSmolagentsPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const spy = vi.fn(tool.forward);
    const r = await spy({ amountUsd: 1, recipient: "0xZ", reason: "spy" });
    expect(spy).toHaveBeenCalledWith({ amountUsd: 1, recipient: "0xZ", reason: "spy" });
    expect(r.amountUsd).toBe(1);
  });
});
