"""
openagentpay-instructor
=======================

OpenAgentPay tool for the `instructor` library (structured LLM outputs).

`instructor` patches an LLM client so responses are validated Pydantic models.
This package gives you:

  * :class:`PaymentRequest` — use as ``response_model`` so the LLM emits a
    typed, validated payment.
  * an async executor that settles that request via the OpenAgentPay HTTP API.
  * :class:`PaymentResult` — the typed settlement outcome.

Usage::

    import instructor
    from openai import OpenAI
    from openagentpay_instructor import (
        PaymentRequest,
        create_payment_executor,
    )

    llm = instructor.from_openai(OpenAI())
    req = llm.chat.completions.create(
        model="gpt-4o-mini",
        response_model=PaymentRequest,
        messages=[{"role": "user", "content": "Pay 0.001 USD to 0xRECIP for data"}],
    )

    pay = create_payment_executor(
        api_url="https://d1p7yxa99nxaye.cloudfront.net",
        user_id="alice",
        default_wallet_provider="coinbase-cdp",
    )
    result = await pay(req)   # -> PaymentResult(success=True, tx_hash="0x…")

Private keys never live client-side — they stay server-side, secured by
@openagentpay/governance.

License: Apache-2.0
"""
from __future__ import annotations

from .client import OpenAgentPayClient
from .errors import OpenAgentPayError
from .tool import (
    create_payment_executor,
    execute_payment,
    has_instructor_sdk,
    payment_response_model,
)
from .types import PaymentRequest, PaymentResult

__version__ = "0.1.0a0"

__all__ = [
    "__version__",
    "OpenAgentPayClient",
    "OpenAgentPayError",
    "PaymentRequest",
    "PaymentResult",
    "create_payment_executor",
    "execute_payment",
    "has_instructor_sdk",
    "payment_response_model",
]
