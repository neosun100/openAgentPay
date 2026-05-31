/**
 * AI SDK v5 plugin tests — verify the descriptor shape ai@5's tool() expects.
 *
 * Key v5 contract: the schema field is `inputSchema` (renamed from v4's
 * `parameters`), and execute(args, options) delegates to the kernel.
 */

import { describe, expect, it } from "vitest";
import { createAiSdkV5PaymentTool } from "../src/index.js";
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
          transactionRef: "0xV5_TX" as never,
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

const baseCfg = () => ({
  manager: makeMockManager(),
  userId: "alice" as UserId,
  defaultWalletProvider: "test-wallet" as WalletProviderId,
});

describe("createAiSdkV5PaymentTool", () => {
  it("returns an AI-SDK-v5-shaped descriptor (inputSchema, not parameters)", () => {
    const tool = createAiSdkV5PaymentTool(baseCfg());
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(typeof tool.execute).toBe("function");
    // v5 renamed `parameters` -> `inputSchema`
    expect(tool).toHaveProperty("inputSchema");
    expect(tool).not.toHaveProperty("parameters");
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toContain("amountUsd");
    expect((schema["properties"] as Record<string, unknown>)["mandates"]).toBeDefined();
  });

  it("execute(args, options) delegates to the kernel runPayment", async () => {
    const tool = createAiSdkV5PaymentTool(baseCfg());
    const r = await tool.execute(
      { amountUsd: 0.001, recipient: "0xR", reason: "ai-sdk-v5 test" },
      { toolCallId: "call_1" }
    );
    expect(r.success).toBe(true);
    expect(r.txHash).toBe("0xV5_TX");
    expect(r.recipient).toBe("0xR");
    expect(r.hadMandates).toBe(false);
  });

  it("propagates AP2 mandates through to the result", async () => {
    const tool = createAiSdkV5PaymentTool(baseCfg());
    const r = await tool.execute({
      amountUsd: 0.5,
      recipient: "0xMerchant",
      reason: "with mandate",
      mandates: [{ kind: "intent" } as never],
    });
    expect(r.success).toBe(true);
    expect(r.hadMandates).toBe(true);
  });

  it("honors a custom inputSchema override (e.g. a zod schema)", () => {
    const fakeZod = { _def: "zod-object", parse: () => ({}) };
    const tool = createAiSdkV5PaymentTool({ ...baseCfg(), inputSchema: fakeZod });
    expect(tool.inputSchema).toBe(fakeZod);
  });
});
