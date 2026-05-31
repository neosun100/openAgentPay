/**
 * LlamaIndex Workflows plugin tests — verify the Workflows step descriptor
 * shape: { name, description, parameters, handler(ev) }.
 */

import { describe, expect, it } from "vitest";
import { createLlamaIndexWorkflowPaymentStep } from "../src/index.js";
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

function makeMockManager(): {
  manager: PaymentManager;
  calls: { processPayment: number };
} {
  let sc = 0,
    ic = 0;
  const calls = { processPayment: 0 };
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
        expiresAt: new Date(
          Date.now() + input.expiresMinutes * 60_000
        ).toISOString(),
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
      calls.processPayment++;
      const s = sessions.get(input.sessionId)!;
      return {
        success: true,
        settlement: {
          success: true,
          transactionRef: "0xWORKFLOW_TX" as never,
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
  return { manager, calls };
}

describe("createLlamaIndexWorkflowPaymentStep", () => {
  it("returns a Workflows-step-shaped descriptor", () => {
    const { manager } = makeMockManager();
    const step = createLlamaIndexWorkflowPaymentStep({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(step.name).toBe("openagentpay_pay");
    expect(typeof step.description).toBe("string");
    expect(typeof step.handler).toBe("function");
    expect((step.parameters as { type: string }).type).toBe("object");
    expect(
      (step.parameters as { required: string[] }).required
    ).toContain("amountUsd");
  });

  it("handler(ev) delegates to runPayment (plain event)", async () => {
    const { manager, calls } = makeMockManager();
    const step = createLlamaIndexWorkflowPaymentStep({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await step.handler({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "workflow test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xWORKFLOW_TX");
    expect(calls.processPayment).toBe(1);
  });

  it("handler(ev) reads input from event .data wrapper", async () => {
    const { manager, calls } = makeMockManager();
    const step = createLlamaIndexWorkflowPaymentStep({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await step.handler({
      data: { amountUsd: 0.002, recipient: "0xR2", reason: "wrapped event" },
    });
    expect(r.success).toBe(true);
    expect(r.recipient).toBe("0xR2");
    expect(calls.processPayment).toBe(1);
  });

  it("parameters schema describes the mandates field for AP2", () => {
    const { manager } = makeMockManager();
    const step = createLlamaIndexWorkflowPaymentStep({
      manager,
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(
      (step.parameters as { properties: Record<string, unknown> }).properties
        .mandates
    ).toBeDefined();
  });
});
