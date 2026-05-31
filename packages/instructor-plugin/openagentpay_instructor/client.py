"""
Async HTTP client for the OpenAgentPay proxy / demo-api deployment.

Mirrors the sibling Python plugins — does NOT reimplement payment logic. It
speaks the same REST contract the python-sdk uses:

    POST /api/session   create a session with budget cap + TTL
    POST /api/pay       sign + settle (returns tx hash on success)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import httpx

from .errors import OpenAgentPayError

DEFAULT_TIMEOUT_S = 30.0
DEFAULT_BUDGET_USD = 5.0
DEFAULT_EXPIRY_MIN = 30


@dataclass(slots=True)
class _SessionState:
    session_id: Optional[str] = None


class OpenAgentPayClient:
    """Async client for the OpenAgentPay HTTP endpoints.

    A per-instance session is created lazily on the first :meth:`pay` and
    reused afterwards. A payment that 404s (expired / cold-Lambda session)
    invalidates the cache and triggers a one-shot retry with a fresh session.
    """

    def __init__(
        self,
        api_url: str,
        *,
        user_id: str = "instructor",
        api_key: str | None = None,
        default_wallet_provider: str | None = None,
        default_budget_usd: float = DEFAULT_BUDGET_USD,
        default_expiry_min: int = DEFAULT_EXPIRY_MIN,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        if not api_url:
            raise ValueError("api_url is required")
        self.api_url = api_url.rstrip("/")
        self.user_id = user_id
        self.api_key = api_key
        self.default_wallet_provider = default_wallet_provider
        self.default_budget_usd = default_budget_usd
        self.default_expiry_min = default_expiry_min
        self.timeout_s = timeout_s
        self._session = _SessionState()
        self.session_creates = 0  # for tests / debug

    # ------------------------------------------------------------------ pay
    async def pay(
        self,
        *,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
    ) -> dict[str, Any]:
        """POST /api/pay with lazy session lifecycle + one-shot 404 retry.

        Returns the raw JSON body. Governance denials / chain failures come
        back as ``{"success": false, ...}`` (NOT exceptions).

        Raises:
            ValueError: on invalid arguments.
            OpenAgentPayError: on non-recoverable transport / 4xx / 5xx errors.
        """
        if amount_usd <= 0:
            raise ValueError("amount_usd must be positive")
        if not recipient:
            raise ValueError("recipient is required")
        if not reason:
            raise ValueError("reason is required")

        provider = wallet_provider or self.default_wallet_provider
        if not provider:
            raise ValueError(
                "wallet_provider not provided and no default_wallet_provider configured"
            )

        sess_id = await self._ensure_session()
        try:
            return await self._do_pay(
                session_id=sess_id,
                amount_usd=amount_usd,
                recipient=recipient,
                reason=reason,
                wallet_provider=provider,
            )
        except OpenAgentPayError as err:
            if err.http_status == 404:
                self._session = _SessionState()
                sess_id = await self._ensure_session()
                return await self._do_pay(
                    session_id=sess_id,
                    amount_usd=amount_usd,
                    recipient=recipient,
                    reason=reason,
                    wallet_provider=provider,
                )
            raise

    # --------------------------------------------------------------- internals

    async def _ensure_session(self) -> str:
        if self._session.session_id:
            return self._session.session_id
        body = {
            "userId": self.user_id,
            "budgetUsd": self.default_budget_usd,
            "expiryMinutes": self.default_expiry_min,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as cli:
                r = await cli.post(
                    f"{self.api_url}/api/session", json=body, headers=self._headers()
                )
        except httpx.HTTPError as e:
            raise OpenAgentPayError(
                f"POST /api/session failed: {e}",
                code="session_create_failed",
            ) from e
        if r.status_code >= 400:
            raise OpenAgentPayError(
                f"create session failed: HTTP {r.status_code}",
                code="session_create_failed",
                http_status=r.status_code,
            )
        data = r.json()
        sid = data.get("sessionId") or data.get("id")
        if not sid:
            raise OpenAgentPayError(
                "session response missing sessionId",
                code="session_create_failed",
            )
        self._session.session_id = sid
        self.session_creates += 1
        return sid

    async def _do_pay(
        self,
        *,
        session_id: str,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "sessionId": session_id,
            "amountUsd": amount_usd,
            "recipient": recipient,
            "reason": reason,
            "walletProvider": wallet_provider,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as cli:
                r = await cli.post(
                    f"{self.api_url}/api/pay", json=body, headers=self._headers()
                )
        except httpx.HTTPError as e:
            raise OpenAgentPayError(
                f"POST /api/pay failed: {e}",
                code="transport_error",
            ) from e
        if r.status_code == 404:
            raise OpenAgentPayError(
                "session not found",
                code="session_not_found",
                http_status=404,
            )
        if r.status_code >= 400:
            payload: Any = {}
            try:
                payload = r.json()
            except Exception:
                payload = {"message": r.text[:200]}
            raise OpenAgentPayError(
                payload.get("message", f"HTTP {r.status_code}"),
                code=str(payload.get("code", "http_error")),
                http_status=r.status_code,
            )
        return r.json()

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h
