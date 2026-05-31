"""
Unit tests for openagentpay.client.OpenAgentPayClient.

All HTTP is mocked via respx — no network. Covers:
    - create_session happy path + field mapping
    - pay success (full paymentPayload), 402 + 400 error mapping
    - get_session success + 404
    - list_wallets envelope parsing
    - get_governance / get_audit raw passthrough
    - pay_once (session + pay in one shot)
    - Authorization bearer header
    - trailing-slash base_url normalization
    - injected client is NOT closed; owned client IS closed
    - non-JSON error body handling
"""
from __future__ import annotations

import httpx
import pytest
import respx

from openagentpay import (
    OpenAgentPayApiError,
    OpenAgentPayClient,
    PayResult,
    SessionInfo,
    WalletList,
)

BASE = "https://test.openagentpay.example"


# ============================================================================
#  Fixtures / helpers
# ============================================================================

def _session_body(session_id: str = "sess-123") -> dict:
    return {
        "sessionId": session_id,
        "budgetUsd": 5,
        "expiryMinutes": 30,
        "createdAt": "2026-05-30T17:00:00Z",
        "expiresAt": "2026-05-30T17:30:00Z",
    }


def _pay_success_body() -> dict:
    return {
        "success": True,
        "txHash": "0xMOCKTX",
        "explorerUrl": "https://explorer/tx/0xMOCKTX",
        "amountUsdc": 0.001,
        "amountAtomic": "1000",
        "payer": "0xPAYER",
        "recipient": "0xRECIP",
        "network": "base-sepolia",
        "walletProvider": "hashkey-chain",
        "paymentPayload": {
            "chainId": 84532,
            "verifyingContract": "0xUSDC",
            "authorization": {
                "from": "0xPAYER",
                "to": "0xRECIP",
                "value": "1000",
                "validAfter": "0",
                "validBefore": "9999999999",
                "nonce": "0xabc",
            },
            "signature": "0xsig",
            "v": 27,
            "r": "0xr",
            "s": "0xs",
        },
    }


# ============================================================================
#  Construction / validation
# ============================================================================

def test_requires_base_url() -> None:
    with pytest.raises(ValueError, match="base_url"):
        OpenAgentPayClient("")


def test_trailing_slash_base_url_normalized() -> None:
    c = OpenAgentPayClient("https://x.example/")
    assert c.base_url == "https://x.example"
    c2 = OpenAgentPayClient("https://x.example///")
    assert c2.base_url == "https://x.example"


# ============================================================================
#  create_session
# ============================================================================

@respx.mock
async def test_create_session() -> None:
    route = respx.post(f"{BASE}/api/session").mock(
        return_value=httpx.Response(200, json=_session_body("sess-abc"))
    )
    async with OpenAgentPayClient(BASE) as c:
        s = await c.create_session(budget_usd=5, expiry_minutes=30)
    assert isinstance(s, SessionInfo)
    assert s.session_id == "sess-abc"
    assert s.budget_usd == 5
    assert s.expiry_minutes == 30
    # request body uses camelCase
    sent = route.calls.last.request
    assert b'"budgetUsd"' in sent.content
    assert b'"expiryMinutes"' in sent.content


# ============================================================================
#  pay
# ============================================================================

@respx.mock
async def test_pay_success_full_payload() -> None:
    respx.post(f"{BASE}/api/pay").mock(
        return_value=httpx.Response(200, json=_pay_success_body())
    )
    async with OpenAgentPayClient(BASE) as c:
        r = await c.pay("sess-123", amount_usdc=0.001, recipient="0xRECIP")
    assert isinstance(r, PayResult)
    assert r.success is True
    assert r.tx_hash == "0xMOCKTX"
    assert r.amount_atomic == "1000"
    assert r.payment_payload is not None
    assert r.payment_payload.chain_id == 84532
    assert r.payment_payload.authorization is not None
    assert r.payment_payload.authorization.from_ == "0xPAYER"
    assert r.payment_payload.r == "0xr"


@respx.mock
async def test_pay_includes_optional_fields_when_set() -> None:
    route = respx.post(f"{BASE}/api/pay").mock(
        return_value=httpx.Response(200, json=_pay_success_body())
    )
    async with OpenAgentPayClient(BASE) as c:
        await c.pay(
            "sess-123",
            amount_usdc=0.001,
            recipient="0xRECIP",
            wallet_provider="hashkey-chain",
        )
    body = route.calls.last.request.content
    assert b'"recipient"' in body
    assert b'"walletProvider"' in body


@respx.mock
async def test_pay_omits_optional_fields_when_none() -> None:
    route = respx.post(f"{BASE}/api/pay").mock(
        return_value=httpx.Response(200, json=_pay_success_body())
    )
    async with OpenAgentPayClient(BASE) as c:
        await c.pay("sess-123", amount_usdc=0.001)
    body = route.calls.last.request.content
    assert b'"recipient"' not in body
    assert b'"walletProvider"' not in body
    assert b'"sessionId"' in body


@respx.mock
async def test_pay_402_raises_typed_error() -> None:
    respx.post(f"{BASE}/api/pay").mock(
        return_value=httpx.Response(
            402,
            json={"error": "Payment Required", "code": "insufficient_funds"},
        )
    )
    async with OpenAgentPayClient(BASE) as c:
        with pytest.raises(OpenAgentPayApiError) as ei:
            await c.pay("sess-123", amount_usdc=999)
    assert ei.value.status == 402
    assert ei.value.code == "insufficient_funds"
    assert "Payment Required" in ei.value.message
    assert ei.value.raw["error"] == "Payment Required"


@respx.mock
async def test_pay_400_raises_typed_error_message_field() -> None:
    respx.post(f"{BASE}/api/pay").mock(
        return_value=httpx.Response(400, json={"message": "sessionId is required"})
    )
    async with OpenAgentPayClient(BASE) as c:
        with pytest.raises(OpenAgentPayApiError) as ei:
            await c.pay("", amount_usdc=1)
    assert ei.value.status == 400
    assert ei.value.message == "sessionId is required"
    assert ei.value.code is None


@respx.mock
async def test_pay_governance_deny_is_success_false_not_error() -> None:
    """A settled 2xx denial returns PayResult, never raises."""
    respx.post(f"{BASE}/api/pay").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": False,
                "amountUsdc": 100,
                "amountAtomic": "100000000",
                "payer": "0xP",
                "recipient": "0xR",
                "network": "base-sepolia",
                "walletProvider": "hashkey-chain",
                "errorCode": "policy_denied",
                "errorMessage": "amount exceeds maxAtomic",
            },
        )
    )
    async with OpenAgentPayClient(BASE) as c:
        r = await c.pay("sess-123", amount_usdc=100)
    assert r.success is False
    assert r.error_code == "policy_denied"
    assert r.tx_hash is None


# ============================================================================
#  get_session
# ============================================================================

@respx.mock
async def test_get_session() -> None:
    respx.get(f"{BASE}/api/session/sess-xyz").mock(
        return_value=httpx.Response(200, json=_session_body("sess-xyz"))
    )
    async with OpenAgentPayClient(BASE) as c:
        s = await c.get_session("sess-xyz")
    assert s.session_id == "sess-xyz"


@respx.mock
async def test_get_session_404_raises() -> None:
    respx.get(f"{BASE}/api/session/nope").mock(
        return_value=httpx.Response(404, json={"error": "session not found"})
    )
    async with OpenAgentPayClient(BASE) as c:
        with pytest.raises(OpenAgentPayApiError) as ei:
            await c.get_session("nope")
    assert ei.value.status == 404
    assert "not found" in ei.value.message


# ============================================================================
#  list_wallets / governance / audit
# ============================================================================

@respx.mock
async def test_list_wallets() -> None:
    respx.get(f"{BASE}/api/wallets").mock(
        return_value=httpx.Response(
            200,
            json={
                "wallets": [
                    {
                        "walletProvider": "hashkey-chain",
                        "displayName": "HashKey Chain",
                        "chainName": "HashKey Chain Testnet",
                        "chainId": 133,
                        "tokenLabel": "USDC",
                        "tokenAddress": "0xToken",
                        "agentAddress": "0xAgent",
                    },
                    {"walletProvider": "coinbase-cdp", "displayName": "CDP"},
                ],
                "defaultProvider": "hashkey-chain",
            },
        )
    )
    async with OpenAgentPayClient(BASE) as c:
        wl = await c.list_wallets()
    assert isinstance(wl, WalletList)
    assert wl.default_provider == "hashkey-chain"
    assert len(wl.wallets) == 2
    assert wl.wallets[0].chain_id == 133
    assert wl.wallets[0].agent_address == "0xAgent"
    assert wl.wallets[1].wallet_provider == "coinbase-cdp"


@respx.mock
async def test_get_governance() -> None:
    respx.get(f"{BASE}/api/governance").mock(
        return_value=httpx.Response(
            200,
            json={
                "policies": [{"name": "amountThreshold(50000000)"}],
                "compliance": {"enabled": True},
            },
        )
    )
    async with OpenAgentPayClient(BASE) as c:
        g = await c.get_governance()
    assert g["compliance"]["enabled"] is True
    assert len(g["policies"]) == 1


@respx.mock
async def test_get_audit() -> None:
    respx.get(f"{BASE}/api/governance/audit").mock(
        return_value=httpx.Response(
            200, json={"events": [{"type": "settlement.completed"}], "count": 1}
        )
    )
    async with OpenAgentPayClient(BASE) as c:
        a = await c.get_audit()
    assert a["count"] == 1
    assert a["events"][0]["type"] == "settlement.completed"


# ============================================================================
#  pay_once
# ============================================================================

@respx.mock
async def test_pay_once_creates_session_then_pays() -> None:
    sess_route = respx.post(f"{BASE}/api/session").mock(
        return_value=httpx.Response(200, json=_session_body("sess-once"))
    )
    pay_route = respx.post(f"{BASE}/api/pay").mock(
        return_value=httpx.Response(200, json=_pay_success_body())
    )
    async with OpenAgentPayClient(BASE) as c:
        r = await c.pay_once(
            budget_usd=5,
            expiry_minutes=30,
            amount_usdc=0.001,
            recipient="0xRECIP",
        )
    assert r.success is True
    assert sess_route.called
    assert pay_route.called
    # the pay call carried the freshly-created session id
    assert b"sess-once" in pay_route.calls.last.request.content


# ============================================================================
#  Auth header
# ============================================================================

@respx.mock
async def test_auth_header_sent_when_api_key_set() -> None:
    route = respx.get(f"{BASE}/api/wallets").mock(
        return_value=httpx.Response(200, json={"wallets": [], "defaultProvider": None})
    )
    async with OpenAgentPayClient(BASE, api_key="oap_sk_test123") as c:
        await c.list_wallets()
    assert route.calls.last.request.headers["authorization"] == "Bearer oap_sk_test123"


@respx.mock
async def test_no_auth_header_when_api_key_absent() -> None:
    route = respx.get(f"{BASE}/api/wallets").mock(
        return_value=httpx.Response(200, json={"wallets": [], "defaultProvider": None})
    )
    async with OpenAgentPayClient(BASE) as c:
        await c.list_wallets()
    assert "authorization" not in route.calls.last.request.headers


# ============================================================================
#  trailing-slash base_url routing
# ============================================================================

@respx.mock
async def test_trailing_slash_base_url_hits_correct_path() -> None:
    # No double-slash in the resolved URL.
    route = respx.post(f"{BASE}/api/session").mock(
        return_value=httpx.Response(200, json=_session_body())
    )
    async with OpenAgentPayClient(f"{BASE}/") as c:
        await c.create_session(budget_usd=1, expiry_minutes=10)
    assert route.called
    assert str(route.calls.last.request.url) == f"{BASE}/api/session"


# ============================================================================
#  Client lifecycle
# ============================================================================

@respx.mock
async def test_injected_client_not_closed() -> None:
    respx.get(f"{BASE}/api/wallets").mock(
        return_value=httpx.Response(200, json={"wallets": [], "defaultProvider": None})
    )
    injected = httpx.AsyncClient()
    async with OpenAgentPayClient(BASE, client=injected) as c:
        await c.list_wallets()
    # aclose() ran on __aexit__ but must NOT close an injected client
    assert injected.is_closed is False
    await injected.aclose()


async def test_owned_client_closed_on_aclose() -> None:
    c = OpenAgentPayClient(BASE)
    owned = c._http  # lazily creates and owns it
    assert owned.is_closed is False
    await c.aclose()
    assert owned.is_closed is True


# ============================================================================
#  Error body edge cases
# ============================================================================

@respx.mock
async def test_non_json_error_body() -> None:
    respx.get(f"{BASE}/api/wallets").mock(
        return_value=httpx.Response(503, text="upstream down")
    )
    async with OpenAgentPayClient(BASE) as c:
        with pytest.raises(OpenAgentPayApiError) as ei:
            await c.list_wallets()
    assert ei.value.status == 503
    assert "upstream down" in ei.value.message
    assert ei.value.code is None
