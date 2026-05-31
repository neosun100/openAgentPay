"""Errors raised by the OpenAgentPay instructor client."""
from __future__ import annotations


class OpenAgentPayError(Exception):
    """Raised when an HTTP call to the OpenAgentPay API fails non-recoverably.

    Attributes:
        code: machine-readable error code (e.g., 'http_error', 'session_create_failed')
        message: human-readable description
        http_status: HTTP status code (None for non-HTTP errors like timeouts)
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "unknown",
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status

    def __repr__(self) -> str:
        return (
            f"OpenAgentPayError(code={self.code!r}, "
            f"message={self.message!r}, http_status={self.http_status!r})"
        )
