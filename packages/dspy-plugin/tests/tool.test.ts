/**
 * DSPy plugin tests — verify the descriptor shape DSPy expects
 * ({ name, description, inputSignature, forward }) and that `forward`
 * delegates to the kernel's runPayment.
 */

import { describe, expect, it, vi } from "vitest";
import { createDspyPaymentTool } from "../src/index.js";
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
          transactionRef: "0xDSPY_TX" as never,
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

describe("createDspyPaymentTool", () => {
  it("returns DSPy-shaped descriptor (name/description/inputSignature/forward)", () => {
    const tool = createDspyPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.forward).toBe("function");
    expect((tool.inputSignature as { type: string }).type).toBe("object");
    expect(
      (tool.inputSignature as { required: string[] }).required
    ).toContain("amountUsd");
  });

  it("forward(args) delegates to the kernel's runPayment", async () => {
    const tool = createDspyPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const r = await tool.forward({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "dspy test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xDSPY_TX");
    expect(r.recipient).toBe("0xR");
  });

  it("forward calls the underlying OpenAgentPayLlamaTool.runPayment exactly once", async () => {
    const proto = (await import("@openagentpay/llamaindex-plugin"))
      .OpenAgentPayLlamaTool.prototype;
    const spy = vi.spyOn(proto, "runPayment");
    const tool = createDspyPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    await tool.forward({ amountUsd: 0.5, recipient: "0xZ", reason: "delegate" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      amountUsd: 0.5,
      recipient: "0xZ",
      reason: "delegate",
    });
    spy.mockRestore();
  });

  it("inputSignature describes the mandates field for AP2", () => {
    const tool = createDspyPaymentTool({
      manager: makeMockManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "test-wallet" as WalletProviderId,
    });
    const props = (tool.inputSignature as { properties: Record<string, unknown> })
      .properties;
    expect(props["mandates"]).toBeDefined();
  });
});
