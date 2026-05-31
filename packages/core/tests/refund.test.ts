/**
 * Tests for InMemoryPaymentManager.refund() — wired RefundExecutor path.
 */

import { describe, expect, it } from "vitest";
import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type TransactionRef,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "../src/types.js";
import { createInMemoryPaymentManager } from "../src/manager/payment-manager.js";
import { EchoRefundExecutor } from "../src/finance/index.js";
import type { RefundRequest } from "../src/finance/index.js";

const PROVIDER = "mock-wallet" as WalletProviderId;
const PROTOCOL = "mock-protocol" as ProtocolId;
const ALICE = "alice" as UserId;

const usdc = (atomic: string): Money => ({
  amountAtomic: atomic,
  decimals: 6,
  currency: "USDC",
});

class MockConnector implements WalletConnector {
  public readonly instruments = new Map<string, Instrument>();
  public settleResult: SettlementResult = {
    success: true,
    transactionRef: "tx-original-1" as TransactionRef,
    network: "mock",
    settledAt: new Date(0).toISOString(),
  };

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: PROVIDER,
      displayName: "Mock Wallet",
      supportedAssets: [{ symbol: "USDC", decimals: 6 } as Asset],
      supportedProtocols: [PROTOCOL],
      requiresUserApproval: false,
      settlesOnChain: false,
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    const id = `payment-instrument-mock-${input.userId}` as InstrumentId;
    const inst: Instrument = {
      id,
      userId: input.userId,
      walletProvider: PROVIDER,
      publicHandle: `mock-${input.userId}`,
      createdAt: new Date(0).toISOString(),
    };
    this.instruments.set(id, inst);
    return inst;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    return {
      instrumentId,
      asset: { symbol: "USDC", decimals: 6 },
      money: usdc("1000000000"),
      fetchedAt: new Date(0).toISOString(),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    return {
      request: input.request,
      signer: "mock",
      signature: "0xsig",
    };
  }

  async settle(_signed: SignedAuthorization): Promise<SettlementResult> {
    return this.settleResult;
  }
}

function makeRequest(): PaymentRequest {
  return {
    protocol: PROTOCOL,
    amount: usdc("100000"), // 0.1 USDC
    recipient: "merchant_x",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: 9_999_999_999,
    nonce: "0xabc",
    rawPayload: {},
  };
}

/** Run a successful payment and return the original transactionRef. */
async function settleOne(
  mgr: ReturnType<typeof createInMemoryPaymentManager>
): Promise<TransactionRef> {
  const session = await mgr.createPaymentSession({
    userId: ALICE,
    budgetUsd: 10,
    expiresMinutes: 60,
  });
  const inst = await mgr.createPaymentInstrument(PROVIDER, { userId: ALICE });
  const r = await mgr.processPayment({
    sessionId: session.id,
    instrumentId: inst.id,
    request: makeRequest(),
  });
  expect(r.success).toBe(true);
  return r.settlement.transactionRef as TransactionRef;
}

describe("InMemoryPaymentManager.refund — happy path", () => {
  it("refunds a settled payment via the executor", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      refundExecutor: new EchoRefundExecutor(),
    });
    const ref = await settleOne(mgr);
    const req: RefundRequest = {
      originalTransactionRef: ref,
      amount: usdc("100000"),
      reason: "customer_request",
      initiatedBy: ALICE,
    };
    const r = await mgr.refund(req);
    expect(r.success).toBe(true);
    expect(r.refundTransactionRef).toBe(`refund-${ref}`);
    expect(r.refundedAmount).toEqual(usdc("100000"));
  });

  it("allows partial refunds that sum to the original", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      refundExecutor: new EchoRefundExecutor(),
    });
    const ref = await settleOne(mgr);
    const half = usdc("50000");
    const r1 = await mgr.refund({
      originalTransactionRef: ref,
      amount: half,
      reason: "merchant_error",
      initiatedBy: ALICE,
    });
    const r2 = await mgr.refund({
      originalTransactionRef: ref,
      amount: half,
      reason: "merchant_error",
      initiatedBy: ALICE,
    });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});

describe("InMemoryPaymentManager.refund — validation", () => {
  it("returns exceeds_original when amount > original", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      refundExecutor: new EchoRefundExecutor(),
    });
    const ref = await settleOne(mgr);
    const r = await mgr.refund({
      originalTransactionRef: ref,
      amount: usdc("200000"), // > 0.1 USDC original
      reason: "other",
      initiatedBy: ALICE,
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("exceeds_original");
  });

  it("returns exceeds_original when partial refunds overflow original", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      refundExecutor: new EchoRefundExecutor(),
    });
    const ref = await settleOne(mgr);
    await mgr.refund({
      originalTransactionRef: ref,
      amount: usdc("80000"),
      reason: "other",
      initiatedBy: ALICE,
    });
    const r2 = await mgr.refund({
      originalTransactionRef: ref,
      amount: usdc("80000"), // 80k + 80k > 100k original
      reason: "other",
      initiatedBy: ALICE,
    });
    expect(r2.success).toBe(false);
    expect(r2.errorCode).toBe("exceeds_original");
  });

  it("returns original_not_found for unknown ref", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      refundExecutor: new EchoRefundExecutor(),
    });
    const r = await mgr.refund({
      originalTransactionRef: "tx-never-existed" as TransactionRef,
      amount: usdc("1"),
      reason: "other",
      initiatedBy: ALICE,
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("original_not_found");
  });

  it("returns not_supported when no executor is wired", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      // no refundExecutor
    });
    const ref = await settleOne(mgr);
    const r = await mgr.refund({
      originalTransactionRef: ref,
      amount: usdc("100000"),
      reason: "other",
      initiatedBy: ALICE,
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("not_supported");
  });
});

describe("InMemoryPaymentManager.refund — idempotency", () => {
  it("replays prior result on duplicate idempotencyKey (no double refund)", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      refundExecutor: new EchoRefundExecutor(),
    });
    const ref = await settleOne(mgr);
    const req: RefundRequest = {
      originalTransactionRef: ref,
      amount: usdc("100000"),
      reason: "duplicate",
      initiatedBy: ALICE,
      idempotencyKey: "refund-key-1",
    };
    const r1 = await mgr.refund(req);
    const r2 = await mgr.refund(req);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r2.refundTransactionRef).toBe(r1.refundTransactionRef);
    // A *third* refund with a NEW key would exceed original — proves the
    // first only consumed the budget once (not twice).
    const r3 = await mgr.refund({
      ...req,
      idempotencyKey: "refund-key-2",
    });
    expect(r3.success).toBe(false);
    expect(r3.errorCode).toBe("exceeds_original");
  });

  it("reports already_refunded for a repeated key whose prior attempt failed", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
      refundExecutor: new EchoRefundExecutor({ failWith: "rpc_error" }),
    });
    const ref = await settleOne(mgr);
    const req: RefundRequest = {
      originalTransactionRef: ref,
      amount: usdc("100000"),
      reason: "other",
      initiatedBy: ALICE,
      idempotencyKey: "k-fail",
    };
    const r1 = await mgr.refund(req);
    expect(r1.success).toBe(false);
    const r2 = await mgr.refund(req);
    expect(r2.success).toBe(false);
    expect(r2.errorCode).toBe("already_refunded");
  });
});
