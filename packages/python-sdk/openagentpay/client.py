"""
Async HTTP client for the OpenAgentPay REST API (oap-proxy / demo-api).

This is the Python twin of the TypeScript ``@openagentpay/sdk`` package: a thin,
fully-typed async wrapper over the same REST surface so a Python agent can talk
to a running ``oap-proxy`` in one line::

    from openagentpay import OpenAgentPayClient

    async with OpenAgentPayClient("https://d1p7yxa99nxaye.cloudfront.net") as oap:
        result = await oap.pay_once(
            budget_usd=5, expiry_minutes=30,
            amount_usdc=0.001, recipient="0xRECIP",
        )
        print(result.success, result.tx_hash)

Design notes
------------
- Responses are surfaced as Pydantic models (:class:`SessionInfo`, :class:`PayResult`,
  :class:`WalletEntry`) so attribute access is typed and validated.
- Non-2xx responses raise :class:`OpenAgentPayApiError` carrying the HTTP status,
  the server's machine code (if any) and the raw JSON body. We never swallow
  errors — governance denials that the server returns as a 2xx ``success=false``
  body come back as a :class:`PayResult`, while transport/HTTP failures raise.
- The client can own its :class:`httpx.AsyncClient` (default) or accept an injected
  one (for tests / connection pooling). Only the owned client is closed on exit.

License: Apache-2.0
"""
from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

DEFAULT_TIMEOUT_S = 30.0


# ==============================================================================
#  Error
# ==============================================================================

class OpenAgentPayApiError(Exception):
    """Raised when the OpenAgentPay REST API returns a non-2xx response.

    Attributes:
        status: HTTP status code (e.g. 402, 400, 404, 503).
        code: machine-readable error code parsed from the body, when present.
        message: human-readable description (server ``error``/``message`` field).
        raw: the decoded JSON body (or ``{"message": <text>}`` if not JSON).
    """

    def __init__(
        self,
        status: int,
        code: str | None,
        message: str,
        raw: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.raw = raw

    def __repr__(self) -> str:
        return (
            f"OpenAgentPayApiError(status={self.status!r}, code={self.code!r}, "
            f"message={self.message!r})"
        )


# ==============================================================================
#  Response models — mirror the REST API JSON shapes
# ==============================================================================

class SessionInfo(BaseModel):
    """A budgeted spending session (POST /api/session, GET /api/session/:id)."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    session_id: str = Field(alias="sessionId")
    budget_usd: float | None = Field(default=None, alias="budgetUsd")
    expiry_minutes: int | None = Field(default=None, alias="expiryMinutes")
    created_at: str | None = Field(default=None, alias="createdAt")
    expires_at: str | None = Field(default=None, alias="expiresAt")


class PaymentAuthorization(BaseModel):
    """The EIP-3009 authorization tuple inside a PayResult.paymentPayload."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    value: str | None = None
    valid_after: str | None = Field(default=None, alias="validAfter")
    valid_before: str | None = Field(default=None, alias="validBefore")
    nonce: str | None = None


class PaymentPayload(BaseModel):
    """Signed transfer-with-authorization payload echoed back by POST /api/pay."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    chain_id: int | None = Field(default=None, alias="chainId")
    verifying_contract: str | None = Field(default=None, alias="verifyingContract")
    authorization: PaymentAuthorization | None = None
    signature: str | None = None
    v: int | None = None
    r: str | None = None
    s: str | None = None


class PayResult(BaseModel):
    """Outcome of POST /api/pay.

    ``success=False`` with ``error_code`` is a *settled* governance/chain denial
    returned as a 2xx body — not an exception. Transport/HTTP failures raise
    :class:`OpenAgentPayApiError` instead.
    """

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    success: bool
    tx_hash: str | None = Field(default=None, alias="txHash")
    explorer_url: str | None = Field(default=None, alias="explorerUrl")
    amount_usdc: float | None = Field(default=None, alias="amountUsdc")
    amount_atomic: str | None = Field(default=None, alias="amountAtomic")
    payer: str | None = None
    recipient: str | None = None
    network: str | None = None
    wallet_provider: str | None = Field(default=None, alias="walletProvider")
    error_code: str | None = Field(default=None, alias="errorCode")
    error_message: str | None = Field(default=None, alias="errorMessage")
    payment_payload: PaymentPayload | None = Field(default=None, alias="paymentPayload")


class WalletEntry(BaseModel):
    """One entry in GET /api/wallets → wallets[]."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    wallet_provider: str = Field(alias="walletProvider")
    display_name: str | None = Field(default=None, alias="displayName")
    chain_name: str | None = Field(default=None, alias="chainName")
    chain_id: int | None = Field(default=None, alias="chainId")
    token_label: str | None = Field(default=None, alias="tokenLabel")
    token_address: str | None = Field(default=None, alias="tokenAddress")
    agent_address: str | None = Field(default=None, alias="agentAddress")


class WalletList(BaseModel):
    """GET /api/wallets envelope."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    wallets: list[WalletEntry] = Field(default_factory=list)
    default_provider: str | None = Field(default=None, alias="defaultProvider")


# ==============================================================================
#  Client
# ==============================================================================

class OpenAgentPayClient:
    """Async client for the OpenAgentPay REST API.

    Args:
        base_url: the oap-proxy / demo-api base URL, e.g.
            ``https://d1p7yxa99nxaye.cloudfront.net``. A trailing slash is fine
            — it is normalized away.
        api_key: optional bearer token; sent as ``Authorization: Bearer <key>``.
        client: optional pre-built :class:`httpx.AsyncClient`. When provided, the
            caller owns its lifecycle (it is *not* closed by ``aclose``); when
            omitted, the client lazily creates and owns one.
        timeout: per-request timeout in seconds for the owned client.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        client: httpx.AsyncClient | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._timeout = timeout
        self._client = client
        # We only close the client if we created it ourselves.
        self._owns_client = client is None

    # ----------------------------------------------------------------
    #  Lifecycle
    # ----------------------------------------------------------------

    @property
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def aclose(self) -> None:
        """Release HTTP resources we own. Safe to call multiple times."""
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> OpenAgentPayClient:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.aclose()

    # ----------------------------------------------------------------
    #  Transport helpers
    # ----------------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
    ) -> Any:
        """Issue a request; return decoded JSON or raise OpenAgentPayApiError."""
        url = f"{self.base_url}{path}"
        try:
            response = await self._http.request(
                method, url, json=json, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            # Network/timeout/connection failures: status 0 sentinel.
            raise OpenAgentPayApiError(
                status=0,
                code="transport_error",
                message=f"{method} {path} failed: {exc}",
                raw=None,
            ) from exc

        if response.status_code >= 400:
            raise _error_from_response(response)

        # 2xx — decode JSON body (empty body → None).
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise OpenAgentPayApiError(
                status=response.status_code,
                code="invalid_json",
                message=f"{method} {path} returned non-JSON body",
                raw=response.text,
            ) from exc

    # ----------------------------------------------------------------
    #  Public API — one method per REST endpoint
    # ----------------------------------------------------------------

    async def create_session(
        self, budget_usd: float, expiry_minutes: int
    ) -> SessionInfo:
        """POST /api/session — open a budgeted spending session."""
        body = await self._request(
            "POST",
            "/api/session",
            json={"budgetUsd": budget_usd, "expiryMinutes": expiry_minutes},
        )
        return SessionInfo.model_validate(body)

    async def get_session(self, id: str) -> SessionInfo:
        """GET /api/session/:id — fetch a session (raises 404 if unknown)."""
        body = await self._request("GET", f"/api/session/{id}")
        return SessionInfo.model_validate(body)

    async def pay(
        self,
        session_id: str,
        amount_usdc: float,
        recipient: str | None = None,
        wallet_provider: str | None = None,
    ) -> PayResult:
        """POST /api/pay — sign + settle a payment within a session.

        A governance/chain denial comes back as ``PayResult(success=False, ...)``;
        only transport/HTTP failures raise :class:`OpenAgentPayApiError`.
        """
        body: dict[str, Any] = {
            "sessionId": session_id,
            "amountUsdc": amount_usdc,
        }
        if recipient is not None:
            body["recipient"] = recipient
        if wallet_provider is not None:
            body["walletProvider"] = wallet_provider
        data = await self._request("POST", "/api/pay", json=body)
        return PayResult.model_validate(data)

    async def list_wallets(self) -> WalletList:
        """GET /api/wallets — enumerate configured wallet providers."""
        body = await self._request("GET", "/api/wallets")
        return WalletList.model_validate(body)

    async def get_governance(self) -> dict[str, Any]:
        """GET /api/governance — policy/governance snapshot (raw dict)."""
        body = await self._request("GET", "/api/governance")
        return dict(body) if isinstance(body, dict) else {"value": body}

    async def get_audit(self) -> dict[str, Any]:
        """GET /api/governance/audit — recent audit events (raw dict)."""
        body = await self._request("GET", "/api/governance/audit")
        return dict(body) if isinstance(body, dict) else {"value": body}

    # ----------------------------------------------------------------
    #  Convenience
    # ----------------------------------------------------------------

    async def pay_once(
        self,
        budget_usd: float,
        expiry_minutes: int,
        amount_usdc: float,
        recipient: str | None = None,
        wallet_provider: str | None = None,
    ) -> PayResult:
        """Create a session then immediately pay from it — the one-liner path.

        Equivalent to :meth:`create_session` followed by :meth:`pay`.
        """
        session = await self.create_session(budget_usd, expiry_minutes)
        return await self.pay(
            session.session_id,
            amount_usdc,
            recipient=recipient,
            wallet_provider=wallet_provider,
        )


# ==============================================================================
#  Internal helpers
# ==============================================================================

def _error_from_response(response: httpx.Response) -> OpenAgentPayApiError:
    """Build an OpenAgentPayApiError from a non-2xx httpx response."""
    raw: Any
    code: str | None = None
    message: str
    try:
        raw = response.json()
    except ValueError:
        raw = response.text
        message = response.text[:300] if response.text else f"HTTP {response.status_code}"
        return OpenAgentPayApiError(
            status=response.status_code, code=None, message=message, raw=raw
        )

    if isinstance(raw, dict):
        message = str(
            raw.get("error")
            or raw.get("message")
            or raw.get("errorMessage")
            or f"HTTP {response.status_code}"
        )
        raw_code = raw.get("code") or raw.get("errorCode")
        code = str(raw_code) if raw_code is not None else None
    else:
        message = f"HTTP {response.status_code}"

    return OpenAgentPayApiError(
        status=response.status_code, code=code, message=message, raw=raw
    )


__all__ = [
    "OpenAgentPayApiError",
    "OpenAgentPayClient",
    "PayResult",
    "PaymentAuthorization",
    "PaymentPayload",
    "SessionInfo",
    "WalletEntry",
    "WalletList",
]
