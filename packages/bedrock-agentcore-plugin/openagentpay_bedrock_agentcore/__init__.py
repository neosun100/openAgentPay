"""
openagentpay-bedrock-agentcore
==============================

AWS Bedrock AgentCore tool descriptor for OpenAgentPay.

**Path-D Hybrid framing**: this package does NOT replace AWS Bedrock AgentCore
Payments. It *extends* AgentCore so an AgentCore-hosted agent can settle through
any of OpenAgentPay's 52 wallet connectors (Binance Pay, OKX, HashKey,
MetaMask, …) — the wallets AgentCore's native CDP/Privy path does not cover.

Usage::

    from openagentpay_bedrock_agentcore import create_payment_tool

    pay = create_payment_tool(
        api_url="https://d1p7yxa99nxaye.cloudfront.net",
        user_id="alice",
        default_wallet_provider="binance",
    )

    # Advertise to the Bedrock model:
    tools = [pay.tool_spec()]

    # When the model emits a tool-use block for `openagentpay_pay`:
    result = await pay.handler({
        "amount_usd": 0.001,
        "recipient": "0xRECIP",
        "reason": "buy market data",
    })

The handler talks the same REST contract as the python-sdk (POST /api/session,
POST /api/pay). Private keys never live client-side.

License: Apache-2.0
"""
from __future__ import annotations

from .client import OpenAgentPayClient
from .errors import OpenAgentPayError
from .tool import (
    AgentCorePaymentTool,
    build_tool_descriptor,
    create_payment_tool,
    has_agentcore_sdk,
)
from .types import PaymentInput, PaymentResult, ToolDescriptor

__version__ = "0.1.0a0"

__all__ = [
    "__version__",
    "AgentCorePaymentTool",
    "OpenAgentPayClient",
    "OpenAgentPayError",
    "PaymentInput",
    "PaymentResult",
    "ToolDescriptor",
    "build_tool_descriptor",
    "create_payment_tool",
    "has_agentcore_sdk",
]
