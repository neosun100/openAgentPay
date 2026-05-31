/**
 * SpinAI plugin tests — verify the action descriptor shape SpinAI expects.
 */

import { describe, expect, it } from "vitest";
import { createSpinAiPaymentAction } from "../src/index.js";
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
          transactionRef: "0xSPINAI_TX" as any,
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

describe("createSpinAiPaymentAction", () => {
  it("returns SpinAI-shaped action descriptor", () => {
    const action = createSpinAiPaymentAction({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(action.id).toBe("openagentpay_pay");
    expect(typeof action.description).toBe("string");
    expect(typeof action.run).toBe("function");
    expect((action.parameters as any).type).toBe("object");
    expect((action.parameters as any).required).toContain("amountUsd");
  });

  it("run(parameters) executes the payment", async () => {
    const action = createSpinAiPaymentAction({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await action.run({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "spinai test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xSPINAI_TX");
    expect(r.walletProvider).toBe("test-wallet");
    expect(r.amountUsd).toBe(0.001);
  });

  it("parameters schema describes mandates field for AP2", () => {
    const action = createSpinAiPaymentAction({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect((action.parameters as any).properties.mandates).toBeDefined();
    expect((action.parameters as any).properties.mandates.type).toBe("array");
  });

  it("run honors a per-call walletProvider override", async () => {
    const action = createSpinAiPaymentAction({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await action.run({
      amountUsd: 0.5,
      recipient: "0xR",
      reason: "override test",
      walletProvider: "hashkey-chain",
    });
    expect(r.success).toBe(true);
    expect(r.walletProvider).toBe("hashkey-chain");
  });
});
