//! Integration tests for the OpenAgentPay client, mocked with `wiremock` —
//! no real network access.

use openagentpay::{
    Client, CreateSessionRequest, OpenAgentPayError, PayOnceRequest, PayRequest, DEFAULT_BASE_URL,
};
use serde_json::json;
use wiremock::matchers::{body_json_string, header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

#[tokio::test]
async fn create_session_sends_body_and_parses_response() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/session"))
        .and(header("content-type", "application/json"))
        .and(body_json_string(
            json!({ "budgetUsd": 10.0, "expiryMinutes": 30 }).to_string(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sessionId": "sess_123",
            "budgetUsd": 10.0,
            "expiryMinutes": 30,
            "createdAt": "2026-05-30T00:00:00Z",
            "expiresAt": "2026-05-30T00:30:00Z"
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let got = client
        .create_session(CreateSessionRequest {
            budget_usd: 10.0,
            expiry_minutes: 30,
        })
        .await
        .expect("create_session ok");

    assert_eq!(got.session_id, "sess_123");
    assert_eq!(got.budget_usd, 10.0);
    assert_eq!(got.expiry_minutes, 30);
    assert_eq!(got.expires_at, "2026-05-30T00:30:00Z");
}

#[tokio::test]
async fn pay_success_parses_payment_payload() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/pay"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "txHash": "0xdeadbeef",
            "explorerUrl": "https://explorer/tx/0xdeadbeef",
            "amountUsdc": 1.5,
            "amountAtomic": "1500000",
            "payer": "0xagent",
            "recipient": "0xabc",
            "network": "base-sepolia",
            "walletProvider": "hashkey",
            "paymentPayload": {
                "chainId": 84532,
                "verifyingContract": "0xUSDC",
                "authorization": {
                    "from": "0xagent",
                    "to": "0xabc",
                    "value": "1500000",
                    "validAfter": "0",
                    "validBefore": "9999999999",
                    "nonce": "0x01"
                },
                "signature": "0xsig",
                "v": 27,
                "r": "0xr",
                "s": "0xs"
            }
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let got = client
        .pay(PayRequest {
            session_id: "sess_123".into(),
            amount_usdc: 1.5,
            recipient: Some("0xabc".into()),
            wallet_provider: None,
        })
        .await
        .expect("pay ok");

    assert!(got.success);
    assert_eq!(got.tx_hash.as_deref(), Some("0xdeadbeef"));
    assert_eq!(got.amount_atomic, "1500000");
    assert_eq!(got.payment_payload.chain_id, 84532);
    assert_eq!(got.payment_payload.authorization.value, "1500000");
    assert_eq!(got.payment_payload.v, 27);
}

#[tokio::test]
async fn pay_request_omits_none_optional_fields() {
    let server = MockServer::start().await;

    // body_json_string asserts the exact serialized body — proves recipient /
    // walletProvider are omitted (skip_serializing_if) rather than sent as null.
    Mock::given(method("POST"))
        .and(path("/api/pay"))
        .and(body_json_string(
            json!({ "sessionId": "s", "amountUsdc": 1.0 }).to_string(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "amountUsdc": 1.0,
            "amountAtomic": "1000000",
            "payer": "0xagent",
            "recipient": "0xdefault",
            "network": "base-sepolia",
            "walletProvider": "hashkey",
            "paymentPayload": {
                "chainId": 84532,
                "verifyingContract": "0xUSDC",
                "authorization": {
                    "from": "0xagent", "to": "0xdefault", "value": "1000000",
                    "validAfter": "0", "validBefore": "1", "nonce": "0x0"
                },
                "signature": "0xsig", "v": 27, "r": "0xr", "s": "0xs"
            }
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let got = client
        .pay(PayRequest {
            session_id: "s".into(),
            amount_usdc: 1.0,
            recipient: None,
            wallet_provider: None,
        })
        .await
        .expect("pay ok");
    assert!(got.success);
    assert!(got.tx_hash.is_none());
}

#[tokio::test]
async fn pay_402_maps_to_api_error_with_code_from_error_field() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/pay"))
        .respond_with(
            ResponseTemplate::new(402).set_body_string(r#"{"error":"insufficient_budget"}"#),
        )
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let err = client
        .pay(PayRequest {
            session_id: "x".into(),
            amount_usdc: 1.0,
            recipient: None,
            wallet_provider: None,
        })
        .await
        .expect_err("expected error");

    match err {
        OpenAgentPayError::Api {
            status,
            code,
            message,
            raw,
        } => {
            assert_eq!(status, 402);
            assert_eq!(code, "insufficient_budget");
            assert_eq!(message, "insufficient_budget");
            assert_eq!(raw, r#"{"error":"insufficient_budget"}"#);
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn pay_400_maps_message_and_explicit_error_code() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/pay"))
        .respond_with(ResponseTemplate::new(400).set_body_string(
            r#"{"message":"missing sessionId","errorCode":"bad_request"}"#,
        ))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let err = client
        .pay(PayRequest {
            session_id: "".into(),
            amount_usdc: 1.0,
            recipient: None,
            wallet_provider: None,
        })
        .await
        .expect_err("expected error");

    match err {
        OpenAgentPayError::Api {
            status,
            code,
            message,
            ..
        } => {
            assert_eq!(status, 400);
            assert_eq!(code, "bad_request");
            assert_eq!(message, "missing sessionId");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn non_json_error_body_falls_back_to_http_code() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/pay"))
        .respond_with(ResponseTemplate::new(500).set_body_string("internal boom"))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let err = client
        .pay(PayRequest {
            session_id: "x".into(),
            amount_usdc: 1.0,
            recipient: None,
            wallet_provider: None,
        })
        .await
        .expect_err("expected error");

    match err {
        OpenAgentPayError::Api {
            status,
            code,
            message,
            ..
        } => {
            assert_eq!(status, 500);
            assert_eq!(code, "http_500");
            assert_eq!(message, "internal boom");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn get_session_found() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/session/sess_abc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sessionId": "sess_abc",
            "budgetUsd": 5.0,
            "expiryMinutes": 60,
            "createdAt": "2026-05-30T00:00:00Z",
            "expiresAt": "2026-05-30T01:00:00Z"
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let got = client.get_session("sess_abc").await.expect("get_session ok");
    assert_eq!(got.session_id, "sess_abc");
    assert_eq!(got.budget_usd, 5.0);
}

#[tokio::test]
async fn get_session_404_maps_to_api_error() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/session/missing"))
        .respond_with(
            ResponseTemplate::new(404).set_body_string(r#"{"error":"session_not_found"}"#),
        )
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let err = client
        .get_session("missing")
        .await
        .expect_err("expected error");

    match err {
        OpenAgentPayError::Api { status, code, .. } => {
            assert_eq!(status, 404);
            assert_eq!(code, "session_not_found");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn get_session_percent_encodes_id() {
    let server = MockServer::start().await;

    // The slash in the id must be encoded to %2F so it stays a single segment.
    Mock::given(method("GET"))
        .and(path("/api/session/weird%2Fid"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sessionId": "weird/id",
            "budgetUsd": 0.0,
            "expiryMinutes": 0,
            "createdAt": "",
            "expiresAt": ""
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let got = client.get_session("weird/id").await.expect("get_session ok");
    assert_eq!(got.session_id, "weird/id");
}

#[tokio::test]
async fn list_wallets_parses() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/wallets"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "wallets": [{
                "walletProvider": "hashkey",
                "displayName": "HashKey",
                "chainName": "Base Sepolia",
                "chainId": 84532,
                "tokenLabel": "USDC",
                "tokenAddress": "0xUSDC",
                "agentAddress": "0xagent"
            }],
            "defaultProvider": "hashkey"
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let got = client.list_wallets().await.expect("list_wallets ok");
    assert_eq!(got.default_provider, "hashkey");
    assert_eq!(got.wallets.len(), 1);
    assert_eq!(got.wallets[0].chain_id, 84532);
    assert_eq!(got.wallets[0].display_name, "HashKey");
}

#[tokio::test]
async fn governance_and_audit_return_raw_json() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/governance"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(r#"{"maxPerTx":100,"enabled":true}"#),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/governance/audit"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"events":[{"id":"e1"}]}"#))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());

    let gov = client.get_governance().await.expect("governance ok");
    assert_eq!(gov["enabled"], json!(true));
    assert_eq!(gov["maxPerTx"], json!(100));

    let audit = client.get_audit().await.expect("audit ok");
    assert!(audit.get("events").is_some());
    assert_eq!(audit["events"][0]["id"], json!("e1"));
}

#[tokio::test]
async fn pay_once_creates_session_then_pays_with_default_expiry() {
    let server = MockServer::start().await;

    // Assert the session is created with the default expiry of 60.
    Mock::given(method("POST"))
        .and(path("/api/session"))
        .and(body_json_string(
            json!({ "budgetUsd": 20.0, "expiryMinutes": 60 }).to_string(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sessionId": "sess_once",
            "budgetUsd": 20.0,
            "expiryMinutes": 60,
            "createdAt": "",
            "expiresAt": ""
        })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/pay"))
        .and(body_json_string(
            json!({ "sessionId": "sess_once", "amountUsdc": 2.0 }).to_string(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "amountUsdc": 2.0,
            "amountAtomic": "2000000",
            "payer": "0xagent",
            "recipient": "0xdefault",
            "network": "base-sepolia",
            "walletProvider": "hashkey",
            "paymentPayload": {
                "chainId": 84532,
                "verifyingContract": "0xUSDC",
                "authorization": {
                    "from": "0xagent", "to": "0xdefault", "value": "2000000",
                    "validAfter": "0", "validBefore": "1", "nonce": "0x0"
                },
                "signature": "0xsig", "v": 27, "r": "0xr", "s": "0xs"
            }
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    let got = client
        .pay_once(PayOnceRequest {
            budget_usd: 20.0,
            amount_usdc: 2.0,
            recipient: None,
            wallet_provider: None,
            expiry_minutes: None,
        })
        .await
        .expect("pay_once ok");

    assert_eq!(got.session.session_id, "sess_once");
    assert!(got.payment.success);
    assert_eq!(got.payment.amount_atomic, "2000000");
}

#[tokio::test]
async fn pay_once_honors_custom_expiry() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/session"))
        .and(body_json_string(
            json!({ "budgetUsd": 5.0, "expiryMinutes": 15 }).to_string(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sessionId": "s2", "budgetUsd": 5.0, "expiryMinutes": 15,
            "createdAt": "", "expiresAt": ""
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/pay"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true, "amountUsdc": 1.0, "amountAtomic": "1000000",
            "payer": "0xagent", "recipient": "0xr", "network": "base-sepolia",
            "walletProvider": "hashkey",
            "paymentPayload": {
                "chainId": 84532, "verifyingContract": "0xUSDC",
                "authorization": {
                    "from": "0xa", "to": "0xr", "value": "1000000",
                    "validAfter": "0", "validBefore": "1", "nonce": "0x0"
                },
                "signature": "0xsig", "v": 27, "r": "0xr", "s": "0xs"
            }
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    client
        .pay_once(PayOnceRequest {
            budget_usd: 5.0,
            amount_usdc: 1.0,
            recipient: None,
            wallet_provider: None,
            expiry_minutes: Some(15),
        })
        .await
        .expect("pay_once ok");
}

#[tokio::test]
async fn api_key_sets_bearer_header() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/wallets"))
        .and(header("authorization", "Bearer secret-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "wallets": [], "defaultProvider": "hashkey"
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri()).with_api_key("secret-key");
    let got = client.list_wallets().await.expect("list_wallets ok");
    assert_eq!(got.default_provider, "hashkey");
}

#[tokio::test]
async fn no_auth_header_when_api_key_unset() {
    let server = MockServer::start().await;

    // Reject any request carrying an Authorization header by only matching ones
    // without it: this mock matches all GETs to the path and returns 200; we
    // additionally assert the header is absent via the recorded request below.
    Mock::given(method("GET"))
        .and(path("/api/wallets"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "wallets": [], "defaultProvider": "hashkey"
        })))
        .mount(&server)
        .await;

    let client = Client::new(server.uri());
    client.list_wallets().await.expect("list_wallets ok");

    let requests = server
        .received_requests()
        .await
        .expect("recorded requests");
    let last: &Request = requests.last().expect("at least one request");
    assert!(
        last.headers.get("authorization").is_none(),
        "expected no Authorization header when api key unset"
    );
}

#[tokio::test]
async fn trailing_slash_base_url_is_normalized() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/wallets"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "wallets": [], "defaultProvider": "hashkey"
        })))
        .mount(&server)
        .await;

    // Append multiple trailing slashes; client must normalize them away so the
    // path stays clean (no `//api/wallets`).
    let client = Client::new(format!("{}///", server.uri()));
    let got = client.list_wallets().await.expect("list_wallets ok");
    assert_eq!(got.default_provider, "hashkey");

    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(requests.last().unwrap().url.path(), "/api/wallets");
}

#[tokio::test]
async fn empty_base_url_defaults() {
    let client = Client::new("");
    assert_eq!(client.base_url(), DEFAULT_BASE_URL);
}
