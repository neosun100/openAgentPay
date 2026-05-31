package openagentpay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// strptr is a small helper for optional string fields.
func strptr(s string) *string { return &s }

// newTestClient spins up an httptest server with the given handler and returns
// a Client pointed at it plus a cleanup func.
func newTestClient(t *testing.T, handler http.HandlerFunc, opts ...Option) (*Client, func()) {
	t.Helper()
	srv := httptest.NewServer(handler)
	c := NewClient(srv.URL, opts...)
	return c, srv.Close
}

func TestCreateSession(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/session" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("expected JSON content-type, got %q", ct)
		}
		var body CreateSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.BudgetUsd != 10 || body.ExpiryMinutes != 30 {
			t.Errorf("unexpected body: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionResponse{
			SessionID:     "sess_123",
			BudgetUsd:     10,
			ExpiryMinutes: 30,
			CreatedAt:     "2026-05-30T00:00:00Z",
			ExpiresAt:     "2026-05-30T00:30:00Z",
		})
	})
	defer cleanup()

	got, err := c.CreateSession(context.Background(), CreateSessionRequest{BudgetUsd: 10, ExpiryMinutes: 30})
	if err != nil {
		t.Fatalf("CreateSession error: %v", err)
	}
	if got.SessionID != "sess_123" || got.BudgetUsd != 10 || got.ExpiryMinutes != 30 {
		t.Errorf("unexpected session: %+v", got)
	}
}

func TestPaySuccess(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/pay" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body PayRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.SessionID != "sess_123" || body.AmountUsdc != 1.5 {
			t.Errorf("unexpected pay body: %+v", body)
		}
		if body.Recipient == nil || *body.Recipient != "0xabc" {
			t.Errorf("expected recipient 0xabc, got %v", body.Recipient)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(PayResponse{
			Success:        true,
			TxHash:         strptr("0xdeadbeef"),
			ExplorerURL:    strptr("https://explorer/tx/0xdeadbeef"),
			AmountUsdc:     1.5,
			AmountAtomic:   "1500000",
			Payer:          "0xagent",
			Recipient:      "0xabc",
			Network:        "base-sepolia",
			WalletProvider: "hashkey",
			PaymentPayload: PaymentPayload{
				ChainID:           84532,
				VerifyingContract: "0xUSDC",
				Authorization: PaymentAuthorization{
					From: "0xagent", To: "0xabc", Value: "1500000",
					ValidAfter: "0", ValidBefore: "9999999999", Nonce: "0x01",
				},
				Signature: "0xsig", V: 27, R: "0xr", S: "0xs",
			},
		})
	})
	defer cleanup()

	got, err := c.Pay(context.Background(), PayRequest{
		SessionID:  "sess_123",
		AmountUsdc: 1.5,
		Recipient:  strptr("0xabc"),
	})
	if err != nil {
		t.Fatalf("Pay error: %v", err)
	}
	if !got.Success || got.TxHash == nil || *got.TxHash != "0xdeadbeef" {
		t.Errorf("unexpected pay response: %+v", got)
	}
	if got.PaymentPayload.ChainID != 84532 || got.PaymentPayload.Authorization.Value != "1500000" {
		t.Errorf("unexpected payload: %+v", got.PaymentPayload)
	}
}

func TestPayErrorStatuses(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		wantCode    string
		wantMessage string
	}{
		{
			name:        "402 payment required with error field",
			status:      http.StatusPaymentRequired,
			body:        `{"error":"insufficient_budget"}`,
			wantCode:    "insufficient_budget",
			wantMessage: "insufficient_budget",
		},
		{
			name:        "400 bad request with message + errorCode",
			status:      http.StatusBadRequest,
			body:        `{"message":"missing sessionId","errorCode":"bad_request"}`,
			wantCode:    "bad_request",
			wantMessage: "missing sessionId",
		},
		{
			name:        "500 non-json body",
			status:      http.StatusInternalServerError,
			body:        "internal boom",
			wantCode:    "http_500",
			wantMessage: "internal boom",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			defer cleanup()

			_, err := c.Pay(context.Background(), PayRequest{SessionID: "x", AmountUsdc: 1})
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("expected *APIError, got %T: %v", err, err)
			}
			if apiErr.Status != tc.status {
				t.Errorf("status: got %d want %d", apiErr.Status, tc.status)
			}
			if apiErr.Code != tc.wantCode {
				t.Errorf("code: got %q want %q", apiErr.Code, tc.wantCode)
			}
			if apiErr.Message != tc.wantMessage {
				t.Errorf("message: got %q want %q", apiErr.Message, tc.wantMessage)
			}
			if apiErr.Raw != tc.body {
				t.Errorf("raw: got %q want %q", apiErr.Raw, tc.body)
			}
		})
	}
}

func TestGetSessionFound(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/session/sess_abc" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionResponse{SessionID: "sess_abc", BudgetUsd: 5})
	})
	defer cleanup()

	got, err := c.GetSession(context.Background(), "sess_abc")
	if err != nil {
		t.Fatalf("GetSession error: %v", err)
	}
	if got.SessionID != "sess_abc" {
		t.Errorf("unexpected session id: %s", got.SessionID)
	}
}

func TestGetSession404(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"session_not_found"}`)
	})
	defer cleanup()

	_, err := c.GetSession(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Status != http.StatusNotFound {
		t.Errorf("status: got %d want 404", apiErr.Status)
	}
	if apiErr.Code != "session_not_found" {
		t.Errorf("code: got %q want session_not_found", apiErr.Code)
	}
}

func TestGetSessionEscapesID(t *testing.T) {
	var gotPath string
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionResponse{SessionID: "weird/id"})
	})
	defer cleanup()

	if _, err := c.GetSession(context.Background(), "weird/id"); err != nil {
		t.Fatalf("GetSession error: %v", err)
	}
	if !strings.Contains(gotPath, "weird%2Fid") {
		t.Errorf("expected escaped id in path, got %q", gotPath)
	}
}

func TestListWallets(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/wallets" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(WalletsResponse{
			Wallets: []WalletInfo{{
				WalletProvider: "hashkey",
				DisplayName:    "HashKey",
				ChainName:      "Base Sepolia",
				ChainID:        84532,
				TokenLabel:     "USDC",
				TokenAddress:   "0xUSDC",
				AgentAddress:   "0xagent",
			}},
			DefaultProvider: "hashkey",
		})
	})
	defer cleanup()

	got, err := c.ListWallets(context.Background())
	if err != nil {
		t.Fatalf("ListWallets error: %v", err)
	}
	if got.DefaultProvider != "hashkey" || len(got.Wallets) != 1 {
		t.Errorf("unexpected wallets: %+v", got)
	}
	if got.Wallets[0].ChainID != 84532 {
		t.Errorf("unexpected chainId: %d", got.Wallets[0].ChainID)
	}
}

func TestGetGovernanceAndAudit(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/governance":
			_, _ = io.WriteString(w, `{"maxPerTx":100,"enabled":true}`)
		case "/api/governance/audit":
			_, _ = io.WriteString(w, `{"events":[{"id":"e1"}]}`)
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
	})
	defer cleanup()

	gov, err := c.GetGovernance(context.Background())
	if err != nil {
		t.Fatalf("GetGovernance error: %v", err)
	}
	if gov["enabled"] != true {
		t.Errorf("unexpected governance: %+v", gov)
	}

	audit, err := c.GetAudit(context.Background())
	if err != nil {
		t.Fatalf("GetAudit error: %v", err)
	}
	if _, ok := audit["events"]; !ok {
		t.Errorf("expected events key, got %+v", audit)
	}
}

func TestPayOnce(t *testing.T) {
	var sawExpiry int
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/session":
			var body CreateSessionRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			sawExpiry = body.ExpiryMinutes
			_ = json.NewEncoder(w).Encode(SessionResponse{SessionID: "sess_once", BudgetUsd: body.BudgetUsd})
		case "/api/pay":
			var body PayRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.SessionID != "sess_once" {
				t.Errorf("pay used wrong session: %s", body.SessionID)
			}
			_ = json.NewEncoder(w).Encode(PayResponse{Success: true, AmountUsdc: body.AmountUsdc, AmountAtomic: "2000000"})
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
	})
	defer cleanup()

	got, err := c.PayOnce(context.Background(), PayOnceRequest{BudgetUsd: 20, AmountUsdc: 2})
	if err != nil {
		t.Fatalf("PayOnce error: %v", err)
	}
	if got.Session.SessionID != "sess_once" || !got.Payment.Success {
		t.Errorf("unexpected payOnce result: %+v", got)
	}
	if sawExpiry != 60 {
		t.Errorf("expected default expiry 60, got %d", sawExpiry)
	}
}

func TestPayOnceCustomExpiry(t *testing.T) {
	var sawExpiry int
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/session":
			var body CreateSessionRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			sawExpiry = body.ExpiryMinutes
			_ = json.NewEncoder(w).Encode(SessionResponse{SessionID: "s2"})
		case "/api/pay":
			_ = json.NewEncoder(w).Encode(PayResponse{Success: true})
		}
	})
	defer cleanup()

	if _, err := c.PayOnce(context.Background(), PayOnceRequest{BudgetUsd: 5, AmountUsdc: 1, ExpiryMinutes: 15}); err != nil {
		t.Fatalf("PayOnce error: %v", err)
	}
	if sawExpiry != 15 {
		t.Errorf("expected expiry 15, got %d", sawExpiry)
	}
}

func TestAPIKeyHeader(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer secret-key" {
			t.Errorf("expected bearer header, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(WalletsResponse{DefaultProvider: "hashkey"})
	}, WithAPIKey("secret-key"))
	defer cleanup()

	if _, err := c.ListWallets(context.Background()); err != nil {
		t.Fatalf("ListWallets error: %v", err)
	}
}

func TestNoAPIKeyHeaderWhenUnset(t *testing.T) {
	c, cleanup := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("expected no auth header, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(WalletsResponse{DefaultProvider: "hashkey"})
	})
	defer cleanup()

	if _, err := c.ListWallets(context.Background()); err != nil {
		t.Fatalf("ListWallets error: %v", err)
	}
}

func TestTrailingSlashBaseURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/wallets" {
			t.Errorf("expected clean path /api/wallets, got %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(WalletsResponse{DefaultProvider: "hashkey"})
	}))
	defer srv.Close()

	// Append multiple trailing slashes; client must normalize them away.
	c := NewClient(srv.URL + "///")
	if _, err := c.ListWallets(context.Background()); err != nil {
		t.Fatalf("ListWallets error: %v", err)
	}
}

func TestNewClientDefaultsBaseURL(t *testing.T) {
	c := NewClient("")
	if c.baseURL != DefaultBaseURL {
		t.Errorf("expected default base url, got %q", c.baseURL)
	}
}

func TestWithHTTPClient(t *testing.T) {
	custom := &http.Client{}
	c := NewClient("https://example.com", WithHTTPClient(custom))
	if c.httpClient != custom {
		t.Error("expected injected http client to be used")
	}
	// nil injection must not clobber the default.
	c2 := NewClient("https://example.com", WithHTTPClient(nil))
	if c2.httpClient == nil {
		t.Error("expected non-nil http client after nil injection")
	}
}

func TestAPIErrorImplementsError(t *testing.T) {
	var err error = &APIError{Status: 402, Code: "x", Message: "nope"}
	if !strings.Contains(err.Error(), "402") || !strings.Contains(err.Error(), "nope") {
		t.Errorf("unexpected error string: %s", err.Error())
	}
}
