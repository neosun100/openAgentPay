# OpenAgentPay × instructor Plugin

`openagentpay-instructor` brings OpenAgentPay payments into
[`instructor`](https://python.useinstructor.com) — the library for structured,
Pydantic-typed LLM outputs.

## The shape

`instructor` patches an LLM client so calls return validated Pydantic models.
So the payment flow is two typed steps:

1. The LLM emits a **`PaymentRequest`** via `response_model=PaymentRequest`.
2. Your code hands that request to an **async executor** that settles it and
   returns a typed **`PaymentResult`**.

No free-form JSON, no string parsing — both ends are Pydantic models.

## Install

```bash
uv add openagentpay-instructor
# optional, for the patched-LLM flow:
uv add "openagentpay-instructor[instructor]"
```

## Use

```python
import instructor
from openai import OpenAI
from openagentpay_instructor import PaymentRequest, create_payment_executor

# 1. LLM produces a validated PaymentRequest
llm = instructor.from_openai(OpenAI())
req = llm.chat.completions.create(
    model="gpt-4o-mini",
    response_model=PaymentRequest,
    messages=[{"role": "user", "content": "Pay 0.001 USD to 0xRECIP for market data"}],
)

# 2. Settle it via OpenAgentPay
pay = create_payment_executor(
    api_url="https://d1p7yxa99nxaye.cloudfront.net",
    user_id="alice",
    default_wallet_provider="coinbase-cdp",
)
result = await pay(req)
# result -> PaymentResult(success=True, tx_hash="0x…", explorer_url="…")
```

You can also drive it without an LLM, building the `PaymentRequest` by hand:

```python
req = PaymentRequest(amount_usd=0.001, recipient="0xRECIP", reason="data",
                     wallet_provider="okx")
result = await pay(req)
```

### Response models

| Model | Role |
| --- | --- |
| `PaymentRequest` | What the LLM emits (`response_model`). Validated: `amount_usd > 0`, non-empty `recipient`/`reason`. |
| `PaymentResult` | Typed settlement outcome. `success`, `tx_hash`, `error_code`, … |

The executor **never raises** — validation errors, governance denials, and
transport failures all come back as `PaymentResult(success=False, error_code=…)`,
keeping the structured-output pipeline type-safe end to end.

## How it works

This is a **thin shim**. It does not implement payment logic or hold keys. It
speaks the same REST contract as the OpenAgentPay python-sdk:

- `POST /api/session` — budget-capped, TTL-bounded session
- `POST /api/pay` — sign + settle (returns tx hash)

Enforcement (budget, policy, sanctions/compliance, audit) is server-side in
`@openagentpay/governance`.

License: Apache-2.0
