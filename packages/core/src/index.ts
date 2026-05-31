/**
 * @openagentpay/core entrypoint
 *
 * Re-exports the canonical type system + lightweight runtime modules
 * (SessionManager, PaymentManager). This package contains zero AWS-specific
 * code — it can be safely imported from Lambda handlers, browser bundles,
 * and CDK stacks alike.
 *
 * @license Apache-2.0
 */

export * from "./types.js";
export * from "./session/manager.js";
export * from "./session/dynamodb-manager.js";
export * from "./manager/payment-manager.js";
export * from "./router/protocol-router.js";
export * from "./router/wallet-router.js";
export * from "./finance/index.js";
