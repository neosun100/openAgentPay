/**
 * Motia plugin tests — verify the step descriptor shape Motia expects
 * and that handler delegates to the kernel's runPayment.
 */

import { describe, expect, it } from "vitest";
import { createMotiaPaymentStep } from "../src/index.js";
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
          transactionRef: "0xMOTIA_TX" as any,
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

describe("createMotiaPaymentStep", () => {
  it("returns Motia-shaped step descriptor", () => {
    const step = createMotiaPaymentStep({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(step.name).toBe("openagentpay_pay");
    expect(typeof step.handler).toBe("function");
    expect(typeof step.description).toBe("string");
    expect((step.inputSchema as any).type).toBe("object");
    expect((step.inputSchema as any).required).toContain("amountUsd");
  });

  it("handler(input, ctx) delegates to runPayment", async () => {
    const step = createMotiaPaymentStep({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await step.handler(
      { amountUsd: 0.001, recipient: "0xR", reason: "motia test" },
      { logger: { info() {} }, traceId: "t-1" }
    );
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xMOTIA_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("handler works without a ctx argument", async () => {
    const step = createMotiaPaymentStep({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await step.handler({
      amountUsd: 0.5,
      recipient: "0xR2",
      reason: "no-ctx",
    });
    expect(r.success).toBe(true);
  });

  it("inputSchema describes mandates field for AP2", () => {
    const step = createMotiaPaymentStep({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect((step.inputSchema as any).properties.mandates).toBeDefined();
    expect((step.inputSchema as any).properties.mandates.type).toBe("array");
  });
});
