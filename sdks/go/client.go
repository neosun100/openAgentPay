package openagentpay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// DefaultBaseURL is the public OpenAgentPay demo endpoint.
const DefaultBaseURL = "https://d1p7yxa99nxaye.cloudfront.net"

// Client is a remote HTTP client for the OpenAgentPay REST API.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// Option configures a Client.
type Option func(*Client)

// WithAPIKey sets a bearer token sent as `Authorization: Bearer <apiKey>`.
func WithAPIKey(apiKey string) Option {
	return func(c *Client) { c.apiKey = apiKey }
}

// WithHTTPClient injects a custom *http.Client (useful for tests/timeouts).
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) {
		if hc != nil {
			c.httpClient = hc
		}
	}
}

// NewClient builds a Client. An empty baseURL falls back to DefaultBaseURL.
// Trailing slashes are trimmed so paths concatenate safely.
func NewClient(baseURL string, opts ...Option) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: http.DefaultClient,
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.httpClient == nil {
		c.httpClient = http.DefaultClient
	}
	return c
}

// ============================================================================
//  Public API — one method per REST route
// ============================================================================

// CreateSession opens a budgeted spending session. POST /api/session.
func (c *Client) CreateSession(ctx context.Context, req CreateSessionRequest) (SessionResponse, error) {
	var out SessionResponse
	err := c.do(ctx, http.MethodPost, "/api/session", req, &out)
	return out, err
}

// Pay executes a payment under an existing session. POST /api/pay.
func (c *Client) Pay(ctx context.Context, req PayRequest) (PayResponse, error) {
	var out PayResponse
	err := c.do(ctx, http.MethodPost, "/api/pay", req, &out)
	return out, err
}

// GetSession fetches a session by id (returns an *APIError with Status 404 if
// missing). GET /api/session/:id.
func (c *Client) GetSession(ctx context.Context, id string) (SessionResponse, error) {
	var out SessionResponse
	path := "/api/session/" + url.PathEscape(id)
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// ListWallets lists available wallet providers and the default. GET /api/wallets.
func (c *Client) ListWallets(ctx context.Context) (WalletsResponse, error) {
	var out WalletsResponse
	err := c.do(ctx, http.MethodGet, "/api/wallets", nil, &out)
	return out, err
}

// GetGovernance returns the current policy snapshot. GET /api/governance.
func (c *Client) GetGovernance(ctx context.Context) (GovernanceResponse, error) {
	var out GovernanceResponse
	err := c.do(ctx, http.MethodGet, "/api/governance", nil, &out)
	return out, err
}

// GetAudit returns recent audit events. GET /api/governance/audit.
func (c *Client) GetAudit(ctx context.Context) (AuditResponse, error) {
	var out AuditResponse
	err := c.do(ctx, http.MethodGet, "/api/governance/audit", nil, &out)
	return out, err
}

// PayOnce creates a session then immediately pays under it. ExpiryMinutes
// defaults to 60 when <= 0.
func (c *Client) PayOnce(ctx context.Context, req PayOnceRequest) (PayOnceResult, error) {
	var result PayOnceResult

	expiry := req.ExpiryMinutes
	if expiry <= 0 {
		expiry = 60
	}

	session, err := c.CreateSession(ctx, CreateSessionRequest{
		BudgetUsd:     req.BudgetUsd,
		ExpiryMinutes: expiry,
	})
	if err != nil {
		return result, err
	}

	payment, err := c.Pay(ctx, PayRequest{
		SessionID:      session.SessionID,
		AmountUsdc:     req.AmountUsdc,
		Recipient:      req.Recipient,
		WalletProvider: req.WalletProvider,
	})
	if err != nil {
		return result, err
	}

	result.Session = session
	result.Payment = payment
	return result, nil
}

// ============================================================================
//  Internals
// ============================================================================

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader
	hasBody := body != nil
	if hasBody {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("openagentpay: marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("openagentpay: build request: %w", err)
	}

	httpReq.Header.Set("Accept", "application/json")
	if hasBody {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("openagentpay: http request: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("openagentpay: read response body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return toAPIError(resp.StatusCode, raw)
	}

	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("openagentpay: decode response: %w", err)
	}
	return nil
}

// toAPIError converts a non-2xx response into a typed *APIError, extracting a
// best-effort machine code and message from common server JSON shapes.
func toAPIError(status int, raw []byte) *APIError {
	apiErr := &APIError{
		Status:  status,
		Code:    fmt.Sprintf("http_%d", status),
		Message: fmt.Sprintf("OpenAgentPay request failed with status %d", status),
		Raw:     string(raw),
	}

	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err == nil {
		if s, ok := stringField(obj, "error"); ok {
			apiErr.Message = s
			apiErr.Code = s
		} else if s, ok := stringField(obj, "message"); ok {
			apiErr.Message = s
		}
		// Prefer an explicit machine code if the server supplied one.
		if s, ok := stringField(obj, "errorCode"); ok {
			apiErr.Code = s
		} else if s, ok := stringField(obj, "code"); ok {
			apiErr.Code = s
		}
		return apiErr
	}

	// Non-JSON body: surface it as the message if present.
	if s := strings.TrimSpace(string(raw)); s != "" {
		apiErr.Message = s
	}
	return apiErr
}

func stringField(obj map[string]any, key string) (string, bool) {
	if v, ok := obj[key]; ok {
		if s, ok := v.(string); ok && s != "" {
			return s, true
		}
	}
	return "", false
}
