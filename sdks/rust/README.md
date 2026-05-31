# OpenAgentPay — Rust SDK

[![crates.io](https://img.shields.io/badge/crates.io-openagentpay-orange)](https://crates.io)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)

The Rust remote HTTP client for **[OpenAgentPay](https://github.com/neosun100/openAgentPay)** — _"LiteLLM for Crypto Agent Payments."_

This is the **client → proxy** half of the LiteLLM analogy: point it at a running `oap-proxy` / demo-api and call payments in one line — no in-process wallet/protocol wiring. It mirrors the TypeScript `@openagentpay/sdk` and Go SDK wire shapes **exactly**.

## Install

```toml
# Cargo.toml
[dependencies]
openagentpay = { path = "../openAgentPay/sdks/rust" }   # or a published version
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The crate uses `reqwest` with `rustls-tls` (no OpenSSL system dependency).

## Quick start

```rust
use openagentpay::{Client, CreateSessionRequest, PayRequest};

#[tokio::main]
async fn main() -> Result<(), openagentpay::OpenAgentPayError> {
    // Defaults to the public demo endpoint when given an empty string.
    let client = Client::new("https://d1p7yxa99nxaye.cloudfront.net");

    // 1) Open a budgeted spending session.
    let session = client
        .create_session(CreateSessionRequest {
            budget_usd: 10.0,
            expiry_minutes: 30,
        })
        .await?;
    println!("session: {}", session.session_id);

    // 2) Pay under it.
    let payment = client
        .pay(PayRequest {
            session_id: session.session_id,
            amount_usdc: 1.5,
            recipient: Some("0xRecipient".into()),
            wallet_provider: None, // use the server default
        })
        .await?;

    println!("tx: {:?}  explorer: {:?}", payment.tx_hash, payment.explorer_url);
    Ok(())
}
```

## One-shot payment

`pay_once` creates a session then immediately pays under it. `expiry_minutes`
defaults to **60** when `None` (or `<= 0`).

```rust
use openagentpay::{Client, PayOnceRequest};

# async fn run() -> Result<(), openagentpay::OpenAgentPayError> {
let client = Client::new("");
let result = client
    .pay_once(PayOnceRequest {
        budget_usd: 20.0,
        amount_usdc: 2.0,
        recipient: None,
        wallet_provider: Some("hashkey".into()),
        expiry_minutes: None, // -> 60
    })
    .await?;

println!("paid {} on session {}", result.payment.amount_atomic, result.session.session_id);
# Ok(())
# }
```

## Authentication

Attach a bearer token (sent as `Authorization: Bearer <key>`):

```rust
let client = openagentpay::Client::new("https://your-proxy.example.com")
    .with_api_key("oap_sk_…");
```

## API surface

| Method | Route | Returns |
| --- | --- | --- |
| `create_session(req)` | `POST /api/session` | `SessionResponse` |
| `pay(req)` | `POST /api/pay` | `PayResponse` |
| `get_session(id)` | `GET /api/session/:id` | `SessionResponse` (404 → `Api` error) |
| `list_wallets()` | `GET /api/wallets` | `WalletsResponse` |
| `get_governance()` | `GET /api/governance` | `GovernanceResponse` (`serde_json::Value`) |
| `get_audit()` | `GET /api/governance/audit` | `AuditResponse` (`serde_json::Value`) |
| `pay_once(req)` | session + pay | `PayOnceResult` |

## Error handling

Every non-2xx response maps to a typed [`OpenAgentPayError::Api`] carrying the
HTTP status, a best-effort machine `code`, a human `message`, and the `raw`
body. Transport/serialization failures surface as `OpenAgentPayError::Http`.

```rust
use openagentpay::OpenAgentPayError;

# async fn run(client: openagentpay::Client) {
match client.get_session("missing").await {
    Ok(s) => println!("{}", s.session_id),
    Err(OpenAgentPayError::Api { status, code, message, .. }) => {
        eprintln!("API error {status} ({code}): {message}");
    }
    Err(OpenAgentPayError::Http(e)) => eprintln!("transport error: {e}"),
}
# }
```

## Money model

Amounts mirror the rest of OpenAgentPay: atomic values are **always strings**
(`amount_atomic`, EIP-3009 `authorization.value`, etc.) to structurally prevent
float drift. `amount_usdc` / `budget_usd` are `f64` for convenience only.

## Testing

```bash
cargo build
cargo test
```

Tests use [`wiremock`](https://crates.io/crates/wiremock) to mock the REST API —
**no real network access**.

## License

Apache-2.0 © Neo Sun
