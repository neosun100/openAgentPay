// Package openagentpay is the Go remote HTTP client for OpenAgentPay.
//
// It is the "client→proxy" half of the LiteLLM analogy: point it at a running
// oap-proxy / demo-api and call payments in one line — no in-process
// wallet/protocol wiring. It mirrors the TypeScript @openagentpay/sdk wire
// shapes exactly.
//
// License: Apache-2.0
package openagentpay

// ============================================================================
//  POST /api/session
// ============================================================================

// CreateSessionRequest is the body for POST /api/session.
type CreateSessionRequest struct {
	BudgetUsd     float64 `json:"budgetUsd"`
	ExpiryMinutes int     `json:"expiryMinutes"`
}

// SessionResponse is returned by POST /api/session and GET /api/session/:id.
type SessionResponse struct {
	SessionID     string  `json:"sessionId"`
	BudgetUsd     float64 `json:"budgetUsd"`
	ExpiryMinutes int     `json:"expiryMinutes"`
	CreatedAt     string  `json:"createdAt"`
	ExpiresAt     string  `json:"expiresAt"`
}

// ============================================================================
//  POST /api/pay
// ============================================================================

// PayRequest is the body for POST /api/pay. Recipient and WalletProvider are
// optional; nil pointers are omitted from the wire payload.
type PayRequest struct {
	SessionID      string  `json:"sessionId"`
	AmountUsdc     float64 `json:"amountUsdc"`
	Recipient      *string `json:"recipient,omitempty"`
	WalletProvider *string `json:"walletProvider,omitempty"`
}

// PaymentAuthorization is the EIP-3009 transferWithAuthorization tuple as
// serialized by the proxy. All numeric fields are stringified to survive JSON
// without precision loss.
type PaymentAuthorization struct {
	From        string `json:"from"`
	To          string `json:"to"`
	Value       string `json:"value"`
	ValidAfter  string `json:"validAfter"`
	ValidBefore string `json:"validBefore"`
	Nonce       string `json:"nonce"`
}

// PaymentPayload is the signed payment envelope returned by POST /api/pay.
type PaymentPayload struct {
	ChainID           int                  `json:"chainId"`
	VerifyingContract string               `json:"verifyingContract"`
	Authorization     PaymentAuthorization `json:"authorization"`
	Signature         string               `json:"signature"`
	V                 int                  `json:"v"`
	R                 string               `json:"r"`
	S                 string               `json:"s"`
}

// PayResponse is returned by POST /api/pay.
type PayResponse struct {
	Success        bool           `json:"success"`
	TxHash         *string        `json:"txHash,omitempty"`
	ExplorerURL    *string        `json:"explorerUrl,omitempty"`
	AmountUsdc     float64        `json:"amountUsdc"`
	AmountAtomic   string         `json:"amountAtomic"`
	Payer          string         `json:"payer"`
	Recipient      string         `json:"recipient"`
	Network        string         `json:"network"`
	WalletProvider string         `json:"walletProvider"`
	ErrorCode      *string        `json:"errorCode,omitempty"`
	ErrorMessage   *string        `json:"errorMessage,omitempty"`
	PaymentPayload PaymentPayload `json:"paymentPayload"`
}

// ============================================================================
//  GET /api/wallets
// ============================================================================

// WalletInfo describes a single available wallet provider.
type WalletInfo struct {
	WalletProvider string `json:"walletProvider"`
	DisplayName    string `json:"displayName"`
	ChainName      string `json:"chainName"`
	ChainID        int    `json:"chainId"`
	TokenLabel     string `json:"tokenLabel"`
	TokenAddress   string `json:"tokenAddress"`
	AgentAddress   string `json:"agentAddress"`
}

// WalletsResponse is returned by GET /api/wallets.
type WalletsResponse struct {
	Wallets         []WalletInfo `json:"wallets"`
	DefaultProvider string       `json:"defaultProvider"`
}

// ============================================================================
//  GET /api/governance  +  GET /api/governance/audit
// ============================================================================

// GovernanceResponse is the policy snapshot — server-defined shape, surfaced
// verbatim as a decoded JSON object.
type GovernanceResponse map[string]any

// AuditResponse is the recent audit events — server-defined shape, surfaced
// verbatim as a decoded JSON object.
type AuditResponse map[string]any

// ============================================================================
//  PayOnce convenience
// ============================================================================

// PayOnceRequest creates a session then pays under it in one call.
type PayOnceRequest struct {
	BudgetUsd      float64
	AmountUsdc     float64
	Recipient      *string
	WalletProvider *string
	// ExpiryMinutes is optional; <= 0 defaults to 60.
	ExpiryMinutes int
}

// PayOnceResult bundles the created session with the executed payment so the
// caller can keep paying on the same session if desired.
type PayOnceResult struct {
	Session SessionResponse
	Payment PayResponse
}
