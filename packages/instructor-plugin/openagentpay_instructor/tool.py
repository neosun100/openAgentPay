"""
instructor integration — Pydantic-typed payment models + an executor.

`instructor` (https://python.useinstructor.com) patches an LLM client so calls
return validated Pydantic models. The natural shape for a payment tool here is:

  1. The LLM emits a :class:`PaymentRequest` via ``response_model=PaymentRequest``.
  2. Your code hands that request to :func:`create_payment_executor`'s callable
     (or :func:`execute_payment`) to actually settle it.

This module exposes:

  * :func:`create_payment_executor` — returns an async ``(PaymentRequest) -> PaymentResult``
    callable bound to a configured OpenAgentPay deployment.
  * :func:`payment_response_model` — returns the :class:`PaymentRequest` model
    to pass as ``response_model`` (convenience for symmetry with sibling plugins).
  * :func:`has_instructor_sdk` — introspection.

No payment logic lives here; the executor delegates to the OpenAgentPay HTTP API.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Optional

from .client import (
    DEFAULT_BUDGET_USD,
    DEFAULT_EXPIRY_MIN,
    OpenAgentPayClient,
)
from .errors import OpenAgentPayError
from .types import PaymentRequest, PaymentResult

# instructor is optional; absence must not break the executor path.
try:  # pragma: no cover — environment-dependent
    import instructor  # type: ignore[import-not-found]  # noqa: F401

    _HAS_INSTRUCTOR = True
except ImportError:  # pragma: no cover
    _HAS_INSTRUCTOR = False


def payment_response_model() -> type[PaymentRequest]:
    """Return the Pydantic model to use as instructor ``response_model``.

    Usage::

        from openagentpay_instructor import payment_response_model
        req = client.chat.completions.create(
            model="gpt-4o-mini",
            response_model=payment_response_model(),
            messages=[...],
        )
    """
    return PaymentRequest


async def execute_payment(
    client: OpenAgentPayClient,
    request: PaymentRequest,
    *,
    default_wallet_provider: str | None = None,
) -> PaymentResult:
    """Settle a single :class:`PaymentRequest` through the OpenAgentPay API.

    Never raises: validation/transport/governance failures all return a
    ``PaymentResult(success=False, ...)`` so the structured-output flow stays
    typed end-to-end.
    """
    provider = request.wallet_provider or default_wallet_provider or client.default_wallet_provider or ""
    try:
        raw = await client.pay(
            amount_usd=request.amount_usd,
            recipient=request.recipient,
            reason=request.reason,
            wallet_provider=request.wallet_provider or default_wallet_provider,
        )
    except OpenAgentPayError as err:
        return PaymentResult(
            success=False,
            wallet_provider=provider,
            amount_usd=request.amount_usd,
            recipient=request.recipient,
            error_code=err.code,
            error_message=err.message,
        )
    except (ValueError, TypeError) as err:
        return PaymentResult(
            success=False,
            wallet_provider=provider,
            amount_usd=request.amount_usd,
            recipient=request.recipient,
            error_code="validation_error",
            error_message=str(err),
        )

    return PaymentResult(
        success=bool(raw.get("success", False)),
        wallet_provider=str(raw.get("walletProvider", provider)),
        amount_usd=request.amount_usd,
        recipient=str(raw.get("recipient", request.recipient)),
        tx_hash=raw.get("txHash"),
        explorer_url=raw.get("explorerUrl"),
        network=raw.get("network"),
        error_code=raw.get("errorCode"),
        error_message=raw.get("errorMessage"),
    )


def create_payment_executor(
    *,
    api_url: str,
    user_id: str = "instructor",
    api_key: Optional[str] = None,
    default_wallet_provider: Optional[str] = None,
    default_budget_usd: float = DEFAULT_BUDGET_USD,
    default_expiry_min: int = DEFAULT_EXPIRY_MIN,
) -> Callable[[PaymentRequest], Awaitable[PaymentResult]]:
    """Build an async ``(PaymentRequest) -> PaymentResult`` executor.

    Args:
        api_url: base URL of the OpenAgentPay proxy / demo-api deployment.
        user_id: identity attached to created sessions.
        api_key: optional bearer token for the proxy.
        default_wallet_provider: wallet used when the request omits ``wallet_provider``.
        default_budget_usd: hard per-session budget cap.
        default_expiry_min: session TTL in minutes.

    Returns:
        Async callable. Feed it the :class:`PaymentRequest` an instructor-patched
        LLM produced; it settles and returns a typed :class:`PaymentResult`.
    """
    client = OpenAgentPayClient(
        api_url=api_url,
        user_id=user_id,
        api_key=api_key,
        default_wallet_provider=default_wallet_provider,
        default_budget_usd=default_budget_usd,
        default_expiry_min=default_expiry_min,
    )

    async def _execute(request: PaymentRequest) -> PaymentResult:
        return await execute_payment(
            client, request, default_wallet_provider=default_wallet_provider
        )

    # Expose the underlying client for advanced callers / tests.
    _execute.client = client  # type: ignore[attr-defined]
    return _execute


def has_instructor_sdk() -> bool:
    """Return True if the optional ``instructor`` SDK is installed."""
    return _HAS_INSTRUCTOR
