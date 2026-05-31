//! Error types for the OpenAgentPay client.

use thiserror::Error;

/// Errors returned by the OpenAgentPay client.
#[derive(Debug, Error)]
pub enum OpenAgentPayError {
    /// A non-2xx HTTP response. Carries the HTTP status, a best-effort machine
    /// code, a human-readable message, and the raw response body for forensics.
    #[error("openagentpay: request failed (status={status} code={code}): {message}")]
    Api {
        /// HTTP status code (e.g. 400, 402, 404, 500).
        status: u16,
        /// Best-effort machine code, derived from the server body when present
        /// (`error` / `errorCode` / `code`), otherwise `http_<status>`.
        code: String,
        /// Human-readable message, derived from the server body when present
        /// (`error` / `message`), otherwise a generic fallback.
        message: String,
        /// The raw response body, surfaced verbatim.
        raw: String,
    },

    /// A transport / serialization error from the underlying HTTP client.
    #[error("openagentpay: http error: {0}")]
    Http(#[from] reqwest::Error),
}

impl OpenAgentPayError {
    /// Build a typed [`OpenAgentPayError::Api`] from a non-2xx response,
    /// extracting a best-effort machine code and message from common server
    /// JSON shapes (`error`, `message`, `errorCode`, `code`).
    pub(crate) fn from_response(status: u16, raw: String) -> Self {
        let mut code = format!("http_{status}");
        let mut message = format!("OpenAgentPay request failed with status {status}");

        if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(&raw) {
            // `error` doubles as both message and code in the proxy's shape.
            if let Some(s) = string_field(&obj, "error") {
                message = s.clone();
                code = s;
            } else if let Some(s) = string_field(&obj, "message") {
                message = s;
            }
            // Prefer an explicit machine code when supplied.
            if let Some(s) = string_field(&obj, "errorCode") {
                code = s;
            } else if let Some(s) = string_field(&obj, "code") {
                code = s;
            }
        } else {
            // Non-JSON body: surface it as the message if present.
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                message = trimmed.to_string();
            }
        }

        OpenAgentPayError::Api {
            status,
            code,
            message,
            raw,
        }
    }
}

/// Extract a non-empty string field from a JSON object.
fn string_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
