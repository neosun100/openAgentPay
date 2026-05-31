# OpenAgentPay × Pydantic AI Plugin

Drop-in [Pydantic AI](https://ai.pydantic.dev/) tool for OpenAgentPay. Lets
Pydantic-AI agents execute autonomous payments with the 7-Layer Guardrail in
force, returning a Pydantic-typed result so the agent's downstream reasoning is
fully structured.

```python
from pydantic_ai import Agent
from openagentpay_pydantic_ai import build_payment_tool

agent = Agent("openai:gpt-4o")
agent.tool_plain(
    build_payment_tool(
        api_url="https://d1p7yxa99nxaye.cloudfront.net",
        default_wallet_provider="coinbase-cdp",
    )
)
```

## What it does

- Wraps the framework-agnostic OpenAgentPay payment kernel as a Pydantic-AI
  tool (sibling to the Strands / AutoGen / CrewAI / Semantic-Kernel plugins).
- Async HTTP client to the OpenAgentPay proxy / demo-api.
- Pydantic-typed input + output models, so the agent gets a validated
  `PaymentResult` (success, transactionRef, settledAmount, explorerUrl) rather
  than free-form text.
- Switch wallets/protocols with one `default_wallet_provider` change — the
  business logic never changes. That's the LiteLLM-for-payments promise.

## Install

```bash
uv add openagentpay-pydantic-ai      # or: pip install openagentpay-pydantic-ai
```

## Test

```bash
uv run --no-project --with pytest python -m pytest tests/ -q
```

## License

Apache-2.0 — part of the [OpenAgentPay](https://github.com/neosun100/openAgentPay) project.
