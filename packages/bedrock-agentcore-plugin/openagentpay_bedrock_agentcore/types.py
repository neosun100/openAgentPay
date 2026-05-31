"""Pydantic v2 input/output models for the Bedrock AgentCore payment tool."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class PaymentInput(BaseModel):
    """Schema the LLM / AgentCore fills in when invoking the payment tool."""

    model_config = ConfigDict(extra="forbid")

    amount_usd: float = Field(
        ..., gt=0, description="Amount in USD. Settles in USDC at 1:1."
    )
    recipient: str = Field(..., min_length=1, description="0x… address or merchant ID.")
    reason: str = Field(..., min_length=1, description="Why this payment (audit trail).")
    wallet_provider: Optional[str] = Field(
        None,
        description="Optional wallet override (e.g. 'binance', 'okx', 'hashkey-chain'). "
        "Defaults to the tool's configured default.",
    )


class PaymentResult(BaseModel):
    """Returned to AgentCore as the tool-call result."""

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
        """JSON-friendly dict (camelCase keys) for LLM/AgentCore consumption."""
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


class ToolDescriptor(BaseModel):
    """AgentCore-compatible function/tool descriptor.

    Shape mirrors the Bedrock Converse `toolSpec` contract: a name, a
    description, and a JSON-Schema `inputSchema`. AgentCore (or any Bedrock
    Converse caller) advertises this to the model so it knows how to call the
    payment handler.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    input_schema: dict[str, Any] = Field(..., alias="inputSchema")

    def to_tool_spec(self) -> dict[str, Any]:
        """Render as a Bedrock Converse `toolSpec` block."""
        return {
            "toolSpec": {
                "name": self.name,
                "description": self.description,
                "inputSchema": {"json": self.input_schema},
            }
        }
