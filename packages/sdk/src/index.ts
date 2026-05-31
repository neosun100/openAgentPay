/**
 * @openagentpay/sdk public entrypoint.
 *
 * The remote, typed HTTP client for an oap-proxy / demo-api deployment — the
 * "client→proxy" half of the LiteLLM analogy. For the in-process payment
 * engine see `@openagentpay/core`.
 *
 * @example
 * ```ts
 * import { OpenAgentPayClient } from "@openagentpay/sdk";
 *
 * const oap = new OpenAgentPayClient({ baseUrl: "https://d1p7yxa99nxaye.cloudfront.net" });
 * const { payment } = await oap.payOnce({ budgetUsd: 5, amountUsdc: 0.01 });
 * console.log(payment.txHash);
 * ```
 *
 * @license Apache-2.0
 */

export {
  OpenAgentPayClient,
  OpenAgentPayApiError,
  type OpenAgentPayClientOptions,
  type FetchLike,
} from "./client.js";

export type {
  CreateSessionRequest,
  SessionResponse,
  PayRequest,
  PayResponse,
  PaymentPayload,
  PaymentAuthorization,
  WalletInfo,
  WalletsResponse,
  GovernanceResponse,
  AuditResponse,
  PayOnceRequest,
  PayOnceResult,
} from "./types.js";

// Re-export the canonical engine domain types so callers can bridge
// wire ↔ in-process without depending on `@openagentpay/core` directly.
export type {
  Money,
  Session,
  SettlementResult,
} from "@openagentpay/core/types";
