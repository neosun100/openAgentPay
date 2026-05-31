# OpenAgentPay × AWS Bedrock AgentCore Plugin

`openagentpay-bedrock-agentcore` exposes an OpenAgentPay payment tool to an
agent running on **AWS Bedrock AgentCore**.

## Path-D Hybrid — extends, never replaces

> **OpenAgentPay EXTENDS AWS Bedrock AgentCore Payments. It does not replace it.**

AgentCore's native payments path settles through **Coinbase CDP** and **Privy**
wallets. OpenAgentPay plugs in *alongside* it as the extension layer for the
**non-CDP/non-Privy** wallets AgentCore doesn't cover — Binance Pay, OKX,
HashKey, MetaMask, and 48 more connectors. Use AgentCore Payments where it's
native; route to this tool for everything else. Same agent, same Converse loop,
broader wallet reach.

## Install

```bash
uv add openagentpay-bedrock-agentcore
# optional full AgentCore runtime wiring:
uv add "openagentpay-bedrock-agentcore[agentcore]"
```

## Use

```python
from openagentpay_bedrock_agentcore import create_payment_tool

pay = create_payment_tool(
    api_url="https://d1p7yxa99nxaye.cloudfront.net",
    user_id="alice",
    default_wallet_provider="binance",   # a wallet AgentCore CDP/Privy doesn't cover
)

# 1. Advertise the tool to the Bedrock model (Converse `toolSpec`):
tool_config = {"tools": [pay.tool_spec()]}

# 2. When the model emits a tool-use block named `openagentpay_pay`, invoke:
result = await pay.handler({
    "amount_usd": 0.001,
    "recipient": "0xRECIP",
    "reason": "buy market data",
    # "wallet_provider": "okx",  # optional per-call override
})
# result -> {"success": True, "txHash": "0x…", "explorerUrl": "…", "network": "…"}
```

### Tool descriptor shape

`pay.tool_spec()` returns a Bedrock Converse `toolSpec` block:

```json
{
  "toolSpec": {
    "name": "openagentpay_pay",
    "description": "Make an autonomous USD-denominated payment via OpenAgentPay …",
    "inputSchema": { "json": { "type": "object", "properties": { … } } }
  }
}
```

The handler returns a JSON-friendly dict and **never raises** to the AgentCore
runtime — validation errors, governance denials, and transport failures all come
back as `{"success": false, "errorCode": "…", "errorMessage": "…"}`.

## How it works

This package is a **thin shim**. It does not implement payment logic, hold
private keys, or sign transactions. It talks the same REST contract as the
OpenAgentPay python-sdk:

- `POST /api/session` — create a budget-capped, TTL-bounded session
- `POST /api/pay` — sign + settle (returns tx hash)

All enforcement (session budget, merchant policy, sanctions/compliance, audit)
happens server-side in `@openagentpay/governance`'s 7-layer Guardrail.

License: Apache-2.0
