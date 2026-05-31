/**
 * EchoRefundExecutor — a trivial {@link RefundExecutor} test double.
 *
 * Echoes back a successful RefundResult with a synthetic
 * `refund-<originalTransactionRef>` transactionRef. Lets tests (and local
 * demos) exercise the full PaymentManager.refund() path without a real
 * wallet/protocol backend.
 *
 * @license Apache-2.0
 */

import type { RefundExecutor, RefundRequest, RefundResult } from "./types.js";
import type { TransactionRef } from "../types.js";

export interface EchoRefundExecutorConfig {
  /** Network label stamped onto results (default: "echo-net"). */
  readonly network?: string;
  /** Override settled timestamp (defaults to Date.now). */
  readonly now?: () => number;
  /** Force every refund to fail with this code (for negative-path tests). */
  readonly failWith?: NonNullable<RefundResult["errorCode"]>;
}

export class EchoRefundExecutor implements RefundExecutor {
  private readonly now: () => number;
  private readonly failWith: RefundResult["errorCode"] | undefined;

  constructor(config: EchoRefundExecutorConfig = {}) {
    this.now = config.now ?? Date.now;
    this.failWith = config.failWith;
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    if (this.failWith !== undefined) {
      return {
        success: false,
        errorCode: this.failWith,
        errorMessage: `EchoRefundExecutor forced failure: ${this.failWith}`,
      };
    }
    return {
      success: true,
      refundTransactionRef: `refund-${req.originalTransactionRef}` as TransactionRef,
      refundedAmount: req.amount,
      settledAt: new Date(this.now()).toISOString(),
    };
  }
}
