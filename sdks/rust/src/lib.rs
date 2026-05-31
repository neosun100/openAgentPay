//! # OpenAgentPay — Rust client
//!
//! A remote HTTP client for the OpenAgentPay REST API. It is the "client→proxy"
//! half of the LiteLLM analogy: point it at a running `oap-proxy` / demo-api and
//! call payments in one line — no in-process wallet/protocol wiring. It mirrors
//! the TypeScript `@openagentpay/sdk` and Go SDK wire shapes exactly.
//!
//! ```no_run
//! use openagentpay::{Client, CreateSessionRequest, PayRequest};
//!
//! # async fn run() -> Result<(), openagentpay::OpenAgentPayError> {
//! let client = Client::new("https://d1p7yxa99nxaye.cloudfront.net");
//!
//! let session = client
//!     .create_session(CreateSessionRequest { budget_usd: 10.0, expiry_minutes: 30 })
//!     .await?;
//!
//! let payment = client
//!     .pay(PayRequest {
//!         session_id: session.session_id,
//!         amount_usdc: 1.5,
//!         recipient: Some("0xRecipient".into()),
//!         wallet_provider: None,
//!     })
//!     .await?;
//!
//! println!("tx: {:?}", payment.tx_hash);
//! # Ok(())
//! # }
//! ```
//!
//! License: Apache-2.0

mod error;
mod types;

pub use error::OpenAgentPayError;
pub use types::*;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// The public OpenAgentPay demo endpoint.
pub const DEFAULT_BASE_URL: &str = "https://d1p7yxa99nxaye.cloudfront.net";

/// A remote HTTP client for the OpenAgentPay REST API.
#[derive(Debug, Clone)]
pub struct Client {
    base_url: String,
    api_key: Option<String>,
    http: reqwest::Client,
}

impl Client {
    /// Build a client pointed at `base_url`. An empty `base_url` falls back to
    /// [`DEFAULT_BASE_URL`]. Trailing slashes are trimmed so paths concatenate
    /// safely.
    pub fn new(base_url: impl Into<String>) -> Self {
        let mut base_url = base_url.into();
        if base_url.is_empty() {
            base_url = DEFAULT_BASE_URL.to_string();
        }
        let base_url = base_url.trim_end_matches('/').to_string();
        Self {
            base_url,
            api_key: None,
            http: reqwest::Client::new(),
        }
    }

    /// Attach a bearer token, sent as `Authorization: Bearer <api_key>`.
    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    /// Inject a custom [`reqwest::Client`] (useful for custom timeouts/proxies).
    pub fn with_http_client(mut self, http: reqwest::Client) -> Self {
        self.http = http;
        self
    }

    /// The base URL this client is pointed at (trailing slashes trimmed).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    // ========================================================================
    //  Public API — one method per REST route
    // ========================================================================

    /// Open a budgeted spending session. `POST /api/session`.
    pub async fn create_session(
        &self,
        req: CreateSessionRequest,
    ) -> Result<SessionResponse, OpenAgentPayError> {
        self.post("/api/session", &req).await
    }

    /// Execute a payment under an existing session. `POST /api/pay`.
    pub async fn pay(&self, req: PayRequest) -> Result<PayResponse, OpenAgentPayError> {
        self.post("/api/pay", &req).await
    }

    /// Fetch a session by id (yields an [`OpenAgentPayError::Api`] with status
    /// 404 if missing). `GET /api/session/:id`.
    pub async fn get_session(&self, id: &str) -> Result<SessionResponse, OpenAgentPayError> {
        let path = format!("/api/session/{}", encode_path_segment(id));
        self.get(&path).await
    }

    /// List available wallet providers and the default. `GET /api/wallets`.
    pub async fn list_wallets(&self) -> Result<WalletsResponse, OpenAgentPayError> {
        self.get("/api/wallets").await
    }

    /// Return the current policy snapshot. `GET /api/governance`.
    pub async fn get_governance(&self) -> Result<GovernanceResponse, OpenAgentPayError> {
        self.get("/api/governance").await
    }

    /// Return recent audit events. `GET /api/governance/audit`.
    pub async fn get_audit(&self) -> Result<AuditResponse, OpenAgentPayError> {
        self.get("/api/governance/audit").await
    }

    /// Create a session then immediately pay under it. `expiry_minutes`
    /// defaults to 60 when `None` or `<= 0`.
    pub async fn pay_once(
        &self,
        req: PayOnceRequest,
    ) -> Result<PayOnceResult, OpenAgentPayError> {
        let expiry = match req.expiry_minutes {
            Some(m) if m > 0 => m,
            _ => 60,
        };

        let session = self
            .create_session(CreateSessionRequest {
                budget_usd: req.budget_usd,
                expiry_minutes: expiry,
            })
            .await?;

        let payment = self
            .pay(PayRequest {
                session_id: session.session_id.clone(),
                amount_usdc: req.amount_usdc,
                recipient: req.recipient,
                wallet_provider: req.wallet_provider,
            })
            .await?;

        Ok(PayOnceResult { session, payment })
    }

    // ========================================================================
    //  Internals
    // ========================================================================

    async fn post<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, OpenAgentPayError> {
        let req = self
            .http
            .post(self.url(path))
            .header(reqwest::header::ACCEPT, "application/json")
            .json(body);
        self.send(req).await
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, OpenAgentPayError> {
        let req = self
            .http
            .get(self.url(path))
            .header(reqwest::header::ACCEPT, "application/json");
        self.send(req).await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn send<T: DeserializeOwned>(
        &self,
        mut req: reqwest::RequestBuilder,
    ) -> Result<T, OpenAgentPayError> {
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }

        let resp = req.send().await?;
        let status = resp.status();
        let raw = resp.text().await?;

        if !status.is_success() {
            return Err(OpenAgentPayError::from_response(status.as_u16(), raw));
        }

        // Empty body but a type was expected: let serde report the precise error.
        let value = serde_json::from_str::<T>(&raw).map_err(|e| OpenAgentPayError::Api {
            status: status.as_u16(),
            code: "decode_error".to_string(),
            message: format!("failed to decode response: {e}"),
            raw,
        })?;
        Ok(value)
    }
}

/// Percent-encode a single path segment so ids containing `/`, spaces, etc. do
/// not break the route (mirrors Go's `url.PathEscape`).
fn encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for &b in segment.as_bytes() {
        match b {
            // RFC 3986 unreserved characters are passed through verbatim.
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
