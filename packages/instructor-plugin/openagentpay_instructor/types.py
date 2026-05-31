"""
Pydantic v2 models for the OpenAgentPay × instructor integration.

`instructor` patches an LLM client to return Pydantic ``response_model``
instances. So the integration shape here is:

  * :class:`PaymentRequest` — the structured payment the LLM emits
    (use it as ``response_model=PaymentRequest`` in an instructor call).
  * :class:`PaymentResult` — what executing that request returns.

The LLM produces a validated PaymentRequest; your code passes it to
:func:`openagentpay_instructor.tool.execute_payment` to actually settle it.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class PaymentRequest(BaseModel):
    """Structured payment the LLM emits via instructor's ``response_model``.

    Example::

        import instructor
        client = instructor.from_openai(OpenAI())
        req = client.chat.completions.create(
            model="gpt-4o-mini",
            response_model=PaymentRequest,
            messages=[{"role": "user", "content": "Pay 0.001 USD to 0xRECIP for data"}],
        )
    """

    model_config = ConfigDict(extra="forbid")

    amount_usd: float = Field(
        ..., gt=0, description="Amount in USD. Settles in USDC at 1:1."
    )
    recipient: str = Field(..., min_length=1, description="0x… address or merchant ID.")
    reason: str = Field(..., min_length=1, description="Why this payment (audit trail).")
    wallet_provider: Optional[str] = Field(
        None,
        description="Optional wallet override (e.g. 'coinbase-cdp', 'hashkey-chain'). "
        "Defaults to the executor's configured default.",
    )


class PaymentResult(BaseModel):
    """Result of executing a :class:`PaymentRequest`.

    Itself a Pydantic model, so it can also be used as an instructor
    ``response_model`` for downstream summarization steps.
    """

    model_config = ConfigDict(extra="allow")

    success: bool
    wallet_provider: str
    amount_usd: float
    recipient: str
    tx_hash: Optional[str] = None
    explorer_url: Optional[str] = None
    network: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """JSON-friendly dict (camelCase keys), omitting None values."""
        d: dict[str, Any] = {
            "success": self.success,
            "walletProvider": self.wallet_provider,
            "amountUsd": self.amount_usd,
            "recipient": self.recipient,
        }
        if self.tx_hash is not None:
            d["txHash"] = self.tx_hash
        if self.explorer_url is not None:
            d["explorerUrl"] = self.explorer_url
        if self.network is not None:
            d["network"] = self.network
        if self.error_code is not None:
            d["errorCode"] = self.error_code
        if self.error_message is not None:
            d["errorMessage"] = self.error_message
        return d
