"""
Unit + integration tests for openagentpay-instructor.

Coverage:
    - PaymentRequest model shape / validation (response_model contract)
    - payment_response_model() returns the PaymentRequest type
    - Successful pay delegates to POST /api/pay (happy path)
    - Session lazy-create then reuse
    - Governance deny → typed PaymentResult(success=False) (no exception)
    - HTTP 5xx → typed PaymentResult(success=False) (executor never raises)
    - Validation error (bad request via client) → typed failure
    - wallet_provider per-request override flows into POST /api/pay body
    - 404 session-expiry → recreate + one-shot retry
    - Client unit checks + error repr + introspection
"""
from __future__ import annotations

import json

import httpx
import pytest
import respx
from pydantic import ValidationError

from openagentpay_instructor import (
    OpenAgentPayClient,
    OpenAgentPayError,
    PaymentRequest,
    PaymentResult,
    create_payment_executor,
    execute_payment,
    payment_response_model,
)
from openagentpay_instructor.tool import has_instructor_sdk

API_URL = "https://test.openagentpay.example"


def _mock_session_and_pay(*, pay_status: int = 200, pay_body: dict | None = None) -> None:
    respx.post(f"{API_URL}/api/session").mock(
        return_value=httpx.Response(
            200, json={"sessionId": "instructor-session-1", "budgetUsd": 5}
        )
    )
    if pay_body is None:
        pay_body = {
            "success": True,
            "txHash": "0xINSTRUCTORTX",
            "explorerUrl": "https://explorer/tx/0xINSTRUCTORTX",
            "walletProvider": "coinbase-cdp",
            "network": "base-sepolia",
            "recipient": "0xRECIP",
        }
    respx.post(f"{API_URL}/api/pay").mock(
        return_value=httpx.Response(pay_status, json=pay_body)
    )


# ---------------------------------------------------------------- models


def test_payment_request_validates() -> None:
    req = PaymentRequest(amount_usd=0.001, recipient="0xR", reason="data")
    assert req.amount_usd == 0.001
    assert req.wallet_provider is None


def test_payment_request_rejects_nonpositive_amount() -> None:
    with pytest.raises(ValidationError):
        PaymentRequest(amount_usd=0, recipient="0xR", reason="data")


def test_payment_request_rejects_empty_recipient() -> None:
    with pytest.raises(ValidationError):
        PaymentRequest(amount_usd=1, recipient="", reason="data")


def test_payment_request_forbids_extra_fields() -> None:
    with pytest.raises(ValidationError):
        PaymentRequest(amount_usd=1, recipient="0xR", reason="data", bogus="x")  # type: ignore[call-arg]


def test_payment_response_model_returns_request_type() -> None:
    assert payment_response_model() is PaymentRequest


def test_payment_result_to_dict_omits_none() -> None:
    r = PaymentResult(success=True, wallet_provider="cdp", amount_usd=1.0, recipient="0xR")
    d = r.to_dict()
    assert d["success"] is True
    assert "errorCode" not in d and "txHash" not in d


# ---------------------------------------------------------------- executor


@respx.mock
async def test_executor_success_delegates_to_pay() -> None:
    _mock_session_and_pay()
    pay = create_payment_executor(api_url=API_URL, default_wallet_provider="coinbase-cdp")
    req = PaymentRequest(amount_usd=0.001, recipient="0xRECIP", reason="market data")
    result = await pay(req)
    assert isinstance(result, PaymentResult)
    assert result.success is True
    assert result.tx_hash == "0xINSTRUCTORTX"
    assert result.wallet_provider == "coinbase-cdp"
    assert respx.calls.call_count == 2  # session + pay


@respx.mock
async def test_executor_session_created_once_then_reused() -> None:
    _mock_session_and_pay()
    pay = create_payment_executor(api_url=API_URL, default_wallet_provider="coinbase-cdp")
    await pay(PaymentRequest(amount_usd=0.001, recipient="0xa", reason="r1"))
    await pay(PaymentRequest(amount_usd=0.002, recipient="0xb", reason="r2"))
    assert pay.client.session_creates == 1  # type: ignore[attr-defined]


@respx.mock
async def test_executor_wallet_provider_override_in_body() -> None:
    _mock_session_and_pay(
        pay_body={
            "success": True,
            "txHash": "0xOKXTX",
            "walletProvider": "okx",
            "recipient": "0xR",
        }
    )
    pay = create_payment_executor(api_url=API_URL, default_wallet_provider="coinbase-cdp")
    req = PaymentRequest(amount_usd=1.0, recipient="0xR", reason="override", wallet_provider="okx")
    result = await pay(req)
    assert result.success is True
    assert result.wallet_provider == "okx"
    body = json.loads(respx.calls.last.request.content)
    assert body["walletProvider"] == "okx"
    assert body["reason"] == "override"


@respx.mock
async def test_executor_governance_deny_typed_failure() -> None:
    _mock_session_and_pay(
        pay_body={
            "success": False,
            "walletProvider": "cdp",
            "recipient": "0xR",
            "errorCode": "policy_denied",
            "errorMessage": "amount exceeds maxAtomic",
        }
    )
    pay = create_payment_executor(api_url=API_URL, default_wallet_provider="cdp")
    result = await pay(PaymentRequest(amount_usd=999.0, recipient="0xR", reason="too much"))
    assert result.success is False
    assert result.error_code == "policy_denied"
    assert result.tx_hash is None


@respx.mock
async def test_executor_5xx_never_raises() -> None:
    respx.post(f"{API_URL}/api/session").mock(return_value=httpx.Response(503, text="down"))
    pay = create_payment_executor(api_url=API_URL, default_wallet_provider="cdp")
    result = await pay(PaymentRequest(amount_usd=0.001, recipient="0xR", reason="r"))
    assert result.success is False
    assert result.error_code == "session_create_failed"


@respx.mock
async def test_executor_recreates_session_after_404() -> None:
    respx.post(f"{API_URL}/api/session").mock(
        side_effect=[
            httpx.Response(200, json={"sessionId": "s1"}),
            httpx.Response(200, json={"sessionId": "s2"}),
        ]
    )
    respx.post(f"{API_URL}/api/pay").mock(
        side_effect=[
            httpx.Response(404, json={"code": "NOT_FOUND", "message": "Session not found"}),
            httpx.Response(
                200,
                json={"success": True, "txHash": "0xTX2", "walletProvider": "cdp", "recipient": "0xR"},
            ),
        ]
    )
    pay = create_payment_executor(api_url=API_URL, default_wallet_provider="cdp")
    result = await pay(PaymentRequest(amount_usd=0.001, recipient="0xR", reason="retry"))
    assert result.success is True
    assert result.tx_hash == "0xTX2"
    assert pay.client.session_creates == 2  # type: ignore[attr-defined]


@respx.mock
async def test_execute_payment_with_explicit_client() -> None:
    _mock_session_and_pay()
    c = OpenAgentPayClient(api_url=API_URL, default_wallet_provider="coinbase-cdp")
    req = PaymentRequest(amount_usd=0.001, recipient="0xRECIP", reason="explicit client")
    result = await execute_payment(c, req)
    assert result.success is True
    assert result.tx_hash == "0xINSTRUCTORTX"


# ---------------------------------------------------------------- client unit


@respx.mock
async def test_client_pay_direct() -> None:
    _mock_session_and_pay()
    c = OpenAgentPayClient(api_url=API_URL, default_wallet_provider="cdp")
    raw = await c.pay(amount_usd=0.001, recipient="0xRECIP", reason="direct")
    assert raw["success"] is True


async def test_client_requires_api_url() -> None:
    with pytest.raises(ValueError, match="api_url"):
        OpenAgentPayClient(api_url="")


async def test_client_requires_wallet_provider() -> None:
    c = OpenAgentPayClient(api_url=API_URL)
    with pytest.raises(ValueError, match="wallet_provider"):
        await c.pay(amount_usd=1, recipient="0xa", reason="r")


def test_error_repr() -> None:
    e = OpenAgentPayError("oops", code="abc", http_status=503)
    s = repr(e)
    assert "abc" in s and "503" in s


def test_has_instructor_sdk_returns_bool() -> None:
    assert isinstance(has_instructor_sdk(), bool)
