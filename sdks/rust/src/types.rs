//! Wire-shape types mirroring the OpenAgentPay REST API (and the TypeScript
//! `@openagentpay/sdk` + Go SDK) exactly.

use serde::{Deserialize, Serialize};

// ============================================================================
//  POST /api/session
// ============================================================================

/// Body for `POST /api/session`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    /// Total budget for the session, in USD.
    pub budget_usd: f64,
    /// Time-to-live for the session, in minutes.
    pub expiry_minutes: i64,
}

/// Returned by `POST /api/session` and `GET /api/session/:id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub session_id: String,
    pub budget_usd: f64,
    pub expiry_minutes: i64,
    pub created_at: String,
    pub expires_at: String,
}

// ============================================================================
//  POST /api/pay
// ============================================================================

/// Body for `POST /api/pay`. `recipient` and `wallet_provider` are optional and
/// omitted from the wire payload when `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayRequest {
    pub session_id: String,
    pub amount_usdc: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_provider: Option<String>,
}

/// EIP-3009 `transferWithAuthorization` tuple as serialized by the proxy. All
/// numeric fields are stringified to survive JSON without precision loss.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentAuthorization {
    pub from: String,
    pub to: String,
    pub value: String,
    pub valid_after: String,
    pub valid_before: String,
    pub nonce: String,
}

/// The signed payment envelope returned by `POST /api/pay`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentPayload {
    pub chain_id: i64,
    pub verifying_contract: String,
    pub authorization: PaymentAuthorization,
    pub signature: String,
    pub v: i64,
    pub r: String,
    pub s: String,
}

/// Returned by `POST /api/pay`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explorer_url: Option<String>,
    pub amount_usdc: f64,
    pub amount_atomic: String,
    pub payer: String,
    pub recipient: String,
    pub network: String,
    pub wallet_provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub payment_payload: PaymentPayload,
}

// ============================================================================
//  GET /api/wallets
// ============================================================================

/// A single available wallet provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletInfo {
    pub wallet_provider: String,
    pub display_name: String,
    pub chain_name: String,
    pub chain_id: i64,
    pub token_label: String,
    pub token_address: String,
    pub agent_address: String,
}

/// Returned by `GET /api/wallets`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletsResponse {
    pub wallets: Vec<WalletInfo>,
    pub default_provider: String,
}

// ============================================================================
//  GET /api/governance  +  GET /api/governance/audit
// ============================================================================

/// Policy snapshot — server-defined shape, surfaced verbatim as decoded JSON.
pub type GovernanceResponse = serde_json::Value;

/// Recent audit events — server-defined shape, surfaced verbatim as decoded JSON.
pub type AuditResponse = serde_json::Value;

// ============================================================================
//  pay_once convenience
// ============================================================================

/// Creates a session then pays under it in one call. `expiry_minutes` defaults
/// to 60 when `None` or `<= 0`.
#[derive(Debug, Clone)]
pub struct PayOnceRequest {
    pub budget_usd: f64,
    pub amount_usdc: f64,
    pub recipient: Option<String>,
    pub wallet_provider: Option<String>,
    /// Optional; `None` or `<= 0` defaults to 60.
    pub expiry_minutes: Option<i64>,
}

/// Bundles the created session with the executed payment so the caller can keep
/// paying on the same session if desired.
#[derive(Debug, Clone)]
pub struct PayOnceResult {
    pub session: SessionResponse,
    pub payment: PayResponse,
}
