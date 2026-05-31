"""
Unit + integration tests for openagentpay-bedrock-agentcore.

Coverage:
    - Tool descriptor / toolSpec shape (AgentCore Converse contract)
    - Successful pay delegates to POST /api/pay (happy path)
    - Session lazy-create then reuse
    - Governance deny → structured failure result (no exception)
    - HTTP 5xx → structured failure result (handler never raises)
    - Validation error → structured failure result
    - walletProvider per-call override flows into POST /api/pay body
    - 404 session-expiry → recreate + one-shot retry
    - Client-level direct pay + error repr + introspection
"""
from __future__ import annotations

import httpx
import pytest
import respx

from openagentpay_bedrock_agentcore import (
    AgentCorePaymentTool,
    OpenAgentPayClient,
    OpenAgentPayError,
    PaymentResult,
    ToolDescriptor,
    build_tool_descriptor,
    create_payment_tool,
)
from openagentpay_bedrock_agentcore.tool import has_agentcore_sdk

API_URL = "https://test.openagentpay.example"


def _mock_session_and_pay(*, pay_status: int = 200, pay_body: dict | None = None) -> None:
    respx.post(f"{API_URL}/api/session").mock(
        return_value=httpx.Response(
            200,
            json={"sessionId": "agentcore-session-1", "budgetUsd": 5, "expiryMinutes": 30},
        )
    )
    if pay_body is None:
        pay_body = {
            "success": True,
            "txHash": "0xAGENTCORETX",
            "explorerUrl": "https://explorer/tx/0xAGENTCORETX",
            "walletProvider": "binance",
            "network": "base-sepolia",
            "recipient": "0xRECIP",
        }
    respx.post(f"{API_URL}/api/pay").mock(
        return_value=httpx.Response(pay_status, json=pay_body)
    )


# ---------------------------------------------------------------- descriptor


def test_tool_descriptor_shape() -> None:
    d = build_tool_descriptor()
    assert isinstance(d, ToolDescriptor)
    assert d.name == "openagentpay_pay"
    assert "OpenAgentPay" in d.description
    # input schema declares the required payment fields
    props = d.input_schema["properties"]
    assert set(d.input_schema["required"]) == {"amount_usd", "recipient", "reason"}
    assert props["amount_usd"]["type"] == "number"
    assert props["wallet_provider"]["type"] == "string"


def test_tool_spec_converse_block() -> None:
    spec = build_tool_descriptor(name="pay_for_research").to_tool_spec()
    assert spec["toolSpec"]["name"] == "pay_for_research"
    # Bedrock Converse wraps the JSON schema under inputSchema.json
    assert "json" in spec["toolSpec"]["inputSchema"]
    assert spec["toolSpec"]["inputSchema"]["json"]["type"] == "object"


def test_create_payment_tool_returns_tool() -> None:
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    assert isinstance(tool, AgentCorePaymentTool)
    assert tool.name == "openagentpay_pay"
    assert tool.tool_spec()["toolSpec"]["name"] == "openagentpay_pay"


def test_create_payment_tool_custom_name() -> None:
    tool = create_payment_tool(
        api_url=API_URL, default_wallet_provider="binance", name="settle"
    )
    assert tool.name == "settle"
    assert tool.descriptor.name == "settle"


# ---------------------------------------------------------------- handler pay


@respx.mock
async def test_handler_success_delegates_to_pay() -> None:
    _mock_session_and_pay()
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    out = await tool.handler(
        {"amount_usd": 0.001, "recipient": "0xRECIP", "reason": "market data"}
    )
    assert out["success"] is True
    assert out["txHash"] == "0xAGENTCORETX"
    assert out["walletProvider"] == "binance"
    # exactly one /api/pay call was made
    assert respx.calls.call_count == 2  # session + pay


@respx.mock
async def test_handler_session_created_once_then_reused() -> None:
    _mock_session_and_pay()
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    await tool.handler({"amount_usd": 0.001, "recipient": "0xa", "reason": "r1"})
    await tool.handler({"amount_usd": 0.002, "recipient": "0xb", "reason": "r2"})
    assert tool._client.session_creates == 1


@respx.mock
async def test_handler_wallet_provider_override_in_body() -> None:
    _mock_session_and_pay(
        pay_body={
            "success": True,
            "txHash": "0xOKXTX",
            "walletProvider": "okx",
            "recipient": "0xR",
        }
    )
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    out = await tool.handler(
        {
            "amount_usd": 1.0,
            "recipient": "0xR",
            "reason": "override test",
            "wallet_provider": "okx",
        }
    )
    assert out["success"] is True
    assert out["walletProvider"] == "okx"
    # verify the override actually hit the /api/pay request body
    pay_req = respx.calls.last.request
    import json as _json

    body = _json.loads(pay_req.content)
    assert body["walletProvider"] == "okx"
    assert body["reason"] == "override test"


@respx.mock
async def test_handler_governance_deny_structured() -> None:
    _mock_session_and_pay(
        pay_body={
            "success": False,
            "walletProvider": "binance",
            "recipient": "0xR",
            "errorCode": "policy_denied",
            "errorMessage": "amount exceeds maxAtomic",
        }
    )
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    out = await tool.handler({"amount_usd": 999.0, "recipient": "0xR", "reason": "too much"})
    assert out["success"] is False
    assert out["errorCode"] == "policy_denied"
    assert "txHash" not in out


@respx.mock
async def test_handler_5xx_never_raises() -> None:
    respx.post(f"{API_URL}/api/session").mock(return_value=httpx.Response(503, text="down"))
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    out = await tool.handler({"amount_usd": 0.001, "recipient": "0xR", "reason": "r"})
    assert out["success"] is False
    assert out["errorCode"] == "session_create_failed"


async def test_handler_validation_error_structured() -> None:
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    out = await tool.handler({"amount_usd": -5, "recipient": "0xR", "reason": "neg"})
    assert out["success"] is False
    assert out["errorCode"] == "validation_error"


async def test_handler_missing_field_validation_error() -> None:
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    out = await tool.handler({"amount_usd": 1.0, "recipient": "0xR"})  # no reason
    assert out["success"] is False
    assert out["errorCode"] == "validation_error"


@respx.mock
async def test_handler_recreates_session_after_404() -> None:
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
                json={
                    "success": True,
                    "txHash": "0xTX2",
                    "walletProvider": "binance",
                    "recipient": "0xR",
                },
            ),
        ]
    )
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="binance")
    out = await tool.handler({"amount_usd": 0.001, "recipient": "0xR", "reason": "retry"})
    assert out["success"] is True
    assert out["txHash"] == "0xTX2"
    assert tool._client.session_creates == 2


# ---------------------------------------------------------------- client/unit


@respx.mock
async def test_client_pay_direct() -> None:
    _mock_session_and_pay()
    c = OpenAgentPayClient(api_url=API_URL, default_wallet_provider="binance")
    raw = await c.pay(amount_usd=0.001, recipient="0xRECIP", reason="direct")
    assert raw["success"] is True
    assert raw["txHash"] == "0xAGENTCORETX"


async def test_client_requires_api_url() -> None:
    with pytest.raises(ValueError, match="api_url"):
        OpenAgentPayClient(api_url="")


async def test_client_requires_wallet_provider() -> None:
    c = OpenAgentPayClient(api_url=API_URL)
    with pytest.raises(ValueError, match="wallet_provider"):
        await c.pay(amount_usd=1, recipient="0xa", reason="r")


async def test_client_pay_validation() -> None:
    c = OpenAgentPayClient(api_url=API_URL, default_wallet_provider="binance")
    with pytest.raises(ValueError, match="amount_usd"):
        await c.pay(amount_usd=0, recipient="0xa", reason="r")
    with pytest.raises(ValueError, match="recipient"):
        await c.pay(amount_usd=1, recipient="", reason="r")
    with pytest.raises(ValueError, match="reason"):
        await c.pay(amount_usd=1, recipient="0xa", reason="")


def test_error_repr() -> None:
    e = OpenAgentPayError("oops", code="abc", http_status=503)
    s = repr(e)
    assert "abc" in s and "503" in s


def test_payment_result_to_dict_omits_none() -> None:
    r = PaymentResult(success=True, wallet_provider="binance", amount_usd=1.0, recipient="0xR")
    d = r.to_dict()
    assert d["success"] is True
    assert "errorCode" not in d and "txHash" not in d


def test_has_agentcore_sdk_returns_bool() -> None:
    assert isinstance(has_agentcore_sdk(), bool)
