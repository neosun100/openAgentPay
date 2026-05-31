/**
 * @openagentpay/sdk — wire types
 * ==============================
 *
 * Request/response shapes for the oap-proxy / demo-api REST surface. These
 * intentionally mirror the JSON the server emits over the wire (camelCase,
 * plain primitives) rather than the richer in-process {@link Money}/{@link Session}
 * domain types from `@openagentpay/core` — the engine types are branded and
 * use nested `Money`, which is not what the HTTP layer returns.
 *
 * Domain types are still re-exported from the package root for convenience so
 * callers can bridge wire ↔ engine when they need to.
 *
 * @license Apache-2.0
 */

// ============================================================================
//  POST /api/session
// ============================================================================

export interface CreateSessionRequest {
  readonly budgetUsd: number;
  readonly expiryMinutes: number;
}

export interface SessionResponse {
  readonly sessionId: string;
  readonly budgetUsd: number;
  readonly expiryMinutes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

// ============================================================================
//  POST /api/pay
// ============================================================================

export interface PayRequest {
  readonly sessionId: string;
  readonly amountUsdc: number;
  readonly recipient?: string;
  readonly walletProvider?: string;
}

/**
 * EIP-3009 `transferWithAuthorization` authorization tuple as serialized by
 * the proxy. All numeric fields are stringified to survive JSON without
 * precision loss.
 */
export interface PaymentAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface PaymentPayload {
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly authorization: PaymentAuthorization;
  readonly signature: string;
  readonly v: number;
  readonly r: string;
  readonly s: string;
}

export interface PayResponse {
  readonly success: boolean;
  readonly txHash?: string;
  readonly explorerUrl?: string;
  readonly amountUsdc: number;
  readonly amountAtomic: string;
  readonly payer: string;
  readonly recipient: string;
  readonly network: string;
  readonly walletProvider: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly paymentPayload: PaymentPayload;
}

// ============================================================================
//  GET /api/wallets
// ============================================================================

export interface WalletInfo {
  readonly walletProvider: string;
  readonly displayName: string;
  readonly chainName: string;
  readonly chainId: number;
  readonly tokenLabel: string;
  readonly tokenAddress: string;
  readonly agentAddress: string;
}

export interface WalletsResponse {
  readonly wallets: readonly WalletInfo[];
  readonly defaultProvider: string;
}

// ============================================================================
//  GET /api/governance  +  GET /api/governance/audit
// ============================================================================

/** Policy snapshot — server-defined shape; surfaced verbatim. */
export type GovernanceResponse = Record<string, unknown>;

/** Recent audit events — server-defined shape; surfaced verbatim. */
export type AuditResponse = Record<string, unknown>;

// ============================================================================
//  payOnce convenience
// ============================================================================

export interface PayOnceRequest {
  readonly budgetUsd: number;
  readonly amountUsdc: number;
  readonly recipient?: string;
  readonly walletProvider?: string;
  readonly expiryMinutes?: number;
}

export interface PayOnceResult {
  readonly session: SessionResponse;
  readonly payment: PayResponse;
}
