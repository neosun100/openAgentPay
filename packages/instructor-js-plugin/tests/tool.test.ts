/**
 * Instructor-JS plugin tests — verify the OpenAI-style function-tool shape.
 */

import { describe, expect, it } from "vitest";
import { createInstructorPaymentTool } from "../src/index.js";
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
          transactionRef: "0xINSTRUCTOR_TX" as never,
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

describe("createInstructorPaymentTool", () => {
  it("returns an OpenAI-style function-tool descriptor", () => {
    const tool = createInstructorPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("openagentpay_pay");
    expect(typeof tool.function.description).toBe("string");
    expect(typeof tool.execute).toBe("function");
    expect((tool.function.parameters as { type?: string }).type).toBe("object");
    expect(
      (tool.function.parameters as { required?: string[] }).required
    ).toContain("amountUsd");
  });

  it("execute(args) delegates to runPayment", async () => {
    const tool = createInstructorPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.execute({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "instructor test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xINSTRUCTOR_TX");
    expect(r.walletProvider).toBe("test-wallet");
  });

  it("execute forwards exact input to the inner runPayment (spy)", async () => {
    const tool = createInstructorPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    // The execute fn closes over the inner OpenAgentPayLlamaTool; assert the
    // observable contract: passing a walletProvider override surfaces in result.
    const r = await tool.execute({
      amountUsd: 0.5,
      recipient: "0xOverride",
      reason: "override test",
      walletProvider: "custom-wallet",
    });
    expect(r.walletProvider).toBe("custom-wallet");
    expect(r.recipient).toBe("0xOverride");
    expect(r.amountUsd).toBe(0.5);
  });

  it("parameters JSON Schema includes the AP2 mandates field", () => {
    const tool = createInstructorPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (tool.function.parameters as { properties: Record<string, unknown> })
      .properties;
    expect(props["mandates"]).toBeDefined();
    expect((props["amountUsd"] as { type?: string }).type).toBe("number");
  });

  it("reports hadMandates=true when a mandate chain is attached", async () => {
    const tool = createInstructorPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.execute({
      amountUsd: 1,
      recipient: "0xR",
      reason: "mandate test",
      mandates: [{ kind: "intent" } as never],
    });
    expect(r.hadMandates).toBe(true);
  });
});
