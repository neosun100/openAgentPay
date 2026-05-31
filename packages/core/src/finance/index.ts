/**
 * @openagentpay/core finance subsystem barrel.
 *
 * Re-exports the financial primitives — types + runtime productizations:
 *   - types          (Receipt / Refund / Subscription / Idempotency / Fx / Sponsor)
 *   - subscription   (InMemorySubscriptionManager)
 *   - receipt        (issueReceipt / signReceiptHmac / verifyReceiptHmac)
 *   - refund executor (EchoRefundExecutor test double)
 *
 * @license Apache-2.0
 */

export * from "./types.js";
export * from "./subscription-manager.js";
export * from "./receipt.js";
export * from "./echo-refund-executor.js";
