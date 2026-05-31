"""
Bedrock AgentCore tool factory.

Path-D Hybrid: this does NOT replace AWS Bedrock AgentCore Payments. It
EXTENDS AgentCore so an AgentCore-hosted agent can settle through any of
OpenAgentPay's 52 wallet connectors (Binance Pay, OKX, HashKey, MetaMask, …)
— the wallets AgentCore's native CDP/Privy path does not cover.

We expose two things:

1. A :class:`ToolDescriptor` (Bedrock Converse ``toolSpec`` shape) the model
   sees so it knows how to call the payment function.
2. An async handler ``(input_dict) -> result_dict`` AgentCore invokes when the
   model emits a tool-use block. The handler delegates to the OpenAgentPay
   HTTP API — no payment logic lives here.

If the optional ``bedrock-agentcore`` SDK is installed, :func:`create_payment_tool`
also returns an object the AgentCore runtime can register directly; otherwise
you wire the descriptor + handler into your own Converse loop.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional

from .client import (
    DEFAULT_BUDGET_USD,
    DEFAULT_EXPIRY_MIN,
    OpenAgentPayClient,
)
from .errors import OpenAgentPayError
from .types import PaymentInput, PaymentResult, ToolDescriptor

# AgentCore SDK is optional. Absence must not break the plain handler path.
try:  # pragma: no cover — environment-dependent
    import bedrock_agentcore  # type: ignore[import-not-found]  # noqa: F401

    _HAS_AGENTCORE = True
except ImportError:  # pragma: no cover
    _HAS_AGENTCORE = False


_TOOL_DESCRIPTION = (
    "Make an autonomous USD-denominated payment via OpenAgentPay (settles in "
    "USDC). Use this when the user authorizes a payment or you hit an HTTP 402 "
    "(Payment Required). Payments are enforced by a 7-layer Guardrail (session "
    "budget, policy, on-chain immutability, sanctions/compliance, identity, "
    "audit) server-side — you cannot bypass them. OpenAgentPay EXTENDS AWS "
    "Bedrock AgentCore Payments to wallets AgentCore's native CDP/Privy path "
    "does not cover."
)

# JSON-Schema input contract advertised to the Bedrock model.
_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "amount_usd": {
            "type": "number",
            "exclusiveMinimum": 0,
            "description": "Amount in USD. Settles in USDC at 1:1.",
        },
        "recipient": {
            "type": "string",
            "minLength": 1,
            "description": "0x… address or merchant ID.",
        },
        "reason": {
            "type": "string",
            "minLength": 1,
            "description": "Short human-readable reason (logged to audit trail).",
        },
        "wallet_provider": {
            "type": "string",
            "description": "Optional wallet override (e.g. 'binance', 'okx', "
            "'hashkey-chain'). Omit to use the agent's configured default.",
        },
    },
    "required": ["amount_usd", "recipient", "reason"],
}


def build_tool_descriptor(name: str = "openagentpay_pay") -> ToolDescriptor:
    """Return the AgentCore/Bedrock-Converse tool descriptor for the payment tool."""
    return ToolDescriptor(
        name=name,
        description=_TOOL_DESCRIPTION,
        inputSchema=_INPUT_SCHEMA,
    )


def create_payment_tool(
    *,
    api_url: str,
    user_id: str = "agentcore",
    api_key: Optional[str] = None,
    default_wallet_provider: Optional[str] = None,
    default_budget_usd: float = DEFAULT_BUDGET_USD,
    default_expiry_min: int = DEFAULT_EXPIRY_MIN,
    name: str = "openagentpay_pay",
) -> "AgentCorePaymentTool":
    """Build an AgentCore-compatible payment tool.

    Args:
        api_url: base URL of the OpenAgentPay proxy / demo-api deployment.
        user_id: identity attached to created sessions (audit + budget scoping).
        api_key: optional bearer token for the proxy.
        default_wallet_provider: wallet used when the model omits ``wallet_provider``.
        default_budget_usd: hard per-session budget cap.
        default_expiry_min: session TTL in minutes.
        name: tool name surfaced to the model. Defaults to "openagentpay_pay".

    Returns:
        :class:`AgentCorePaymentTool` exposing ``.descriptor`` (toolSpec) and an
        awaitable ``.handler(input_dict)`` AgentCore invokes on tool-use.
    """
    client = OpenAgentPayClient(
        api_url=api_url,
        user_id=user_id,
        api_key=api_key,
        default_wallet_provider=default_wallet_provider,
        default_budget_usd=default_budget_usd,
        default_expiry_min=default_expiry_min,
    )
    return AgentCorePaymentTool(client=client, name=name)


class AgentCorePaymentTool:
    """A registerable payment tool for AWS Bedrock AgentCore.

    ``.descriptor`` is the toolSpec the model sees; ``.handler`` is the async
    callable AgentCore invokes when the model emits a matching tool-use block.
    The handler returns a JSON-friendly dict; it NEVER raises to the runtime —
    all errors are converted to ``{"success": false, "errorCode": ...}``.
    """

    def __init__(self, *, client: OpenAgentPayClient, name: str) -> None:
        self._client = client
        self.name = name
        self.descriptor = build_tool_descriptor(name)

    def tool_spec(self) -> dict[str, Any]:
        """Bedrock Converse ``toolSpec`` block for this tool."""
        return self.descriptor.to_tool_spec()

    async def handler(self, input_dict: dict[str, Any]) -> dict[str, Any]:
        """Invoke the payment. Accepts the model's tool-use input dict.

        Always returns a JSON-friendly dict. Validation errors, governance
        denials, and transport errors all surface as structured results — the
        AgentCore runtime never sees an exception.
        """
        try:
            parsed = PaymentInput.model_validate(input_dict)
        except Exception as e:  # pydantic ValidationError or bad shape
            return PaymentResult(
                success=False,
                wallet_provider=str(input_dict.get("wallet_provider", "")),
                amount_usd=float(input_dict.get("amount_usd", 0) or 0),
                recipient=str(input_dict.get("recipient", "")),
                error_code="validation_error",
                error_message=str(e),
            ).to_dict()

        provider = parsed.wallet_provider or self._client.default_wallet_provider or ""
        try:
            raw = await self._client.pay(
                amount_usd=parsed.amount_usd,
                recipient=parsed.recipient,
                reason=parsed.reason,
                wallet_provider=parsed.wallet_provider,
            )
        except OpenAgentPayError as err:
            return PaymentResult(
                success=False,
                wallet_provider=provider,
                amount_usd=parsed.amount_usd,
                recipient=parsed.recipient,
                error_code=err.code,
                error_message=err.message,
            ).to_dict()
        except (ValueError, TypeError) as err:
            return PaymentResult(
                success=False,
                wallet_provider=provider,
                amount_usd=parsed.amount_usd,
                recipient=parsed.recipient,
                error_code="validation_error",
                error_message=str(err),
            ).to_dict()

        return PaymentResult(
            success=bool(raw.get("success", False)),
            wallet_provider=str(raw.get("walletProvider", provider)),
            amount_usd=parsed.amount_usd,
            recipient=str(raw.get("recipient", parsed.recipient)),
            tx_hash=raw.get("txHash"),
            explorer_url=raw.get("explorerUrl"),
            network=raw.get("network"),
            error_code=raw.get("errorCode"),
            error_message=raw.get("errorMessage"),
        ).to_dict()


def has_agentcore_sdk() -> bool:
    """Return True if the optional ``bedrock-agentcore`` SDK is installed."""
    return _HAS_AGENTCORE
