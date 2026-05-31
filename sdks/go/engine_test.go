package openagentpay

import (
	"context"
	"errors"
	"testing"
	"time"
)

// failConnector is a Connector whose Settle always fails — used to prove the
// engine leaves session accounting untouched on settlement failure.
type failConnector struct{ provider string }

func (f *failConnector) Provider() string { return f.provider }
func (f *failConnector) Settle(ctx context.Context, req PaymentRequest) (SettlementResult, error) {
	return SettlementResult{}, &EngineError{Code: "settle_failed", Message: "boom"}
}

func usdc(atomic string) Money { return Money{AmountAtomic: atomic, Decimals: 6, Currency: "USDC"} }

// engineErrCode extracts the EngineError code from err, or "" if not one.
func engineErrCode(err error) string {
	var e *EngineError
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// ----------------------------------------------------------------------------
//  ParseAmount
// ----------------------------------------------------------------------------

func TestParseAmount(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		wantAtomic string
		wantDec    int
		wantCur    string
		wantErr    bool
	}{
		{name: "1.5 USDC no space", in: "1.5USDC", wantAtomic: "1500000", wantDec: 6, wantCur: "USDC"},
		{name: "1.5 USDC with space", in: "1.5 USDC", wantAtomic: "1500000", wantDec: 6, wantCur: "USDC"},
		{name: "integer USDC", in: "10USDC", wantAtomic: "10000000", wantDec: 6, wantCur: "USDC"},
		{name: "leading dot", in: ".5USDC", wantAtomic: "500000", wantDec: 6, wantCur: "USDC"},
		{name: "full precision USDC", in: "0.000001USDC", wantAtomic: "1", wantDec: 6, wantCur: "USDC"},
		{name: "zero", in: "0USDC", wantAtomic: "0", wantDec: 6, wantCur: "USDC"},
		{name: "DAI 18 decimals", in: "1DAI", wantAtomic: "1000000000000000000", wantDec: 18, wantCur: "DAI"},
		{name: "lowercase currency normalized", in: "2usdc", wantAtomic: "2000000", wantDec: 6, wantCur: "USDC"},
		{name: "BTC 8 decimals", in: "0.5BTC", wantAtomic: "50000000", wantDec: 8, wantCur: "BTC"},
		{name: "empty", in: "", wantErr: true},
		{name: "no currency", in: "1.5", wantErr: true},
		{name: "no number", in: "USDC", wantErr: true},
		{name: "unknown currency", in: "1FOO", wantErr: true},
		{name: "double dot", in: "1.2.3USDC", wantErr: true},
		{name: "too many fractional digits", in: "0.0000001USDC", wantErr: true}, // 7 frac digits > 6
		{name: "garbage", in: "abc", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseAmount(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("ParseAmount(%q) expected error, got %+v", tc.in, got)
				}
				if engineErrCode(err) != CodeInvalidAmount {
					t.Errorf("expected invalid_amount code, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseAmount(%q) unexpected error: %v", tc.in, err)
			}
			if got.AmountAtomic != tc.wantAtomic || got.Decimals != tc.wantDec || got.Currency != tc.wantCur {
				t.Errorf("ParseAmount(%q) = %+v, want {%s %d %s}", tc.in, got, tc.wantAtomic, tc.wantDec, tc.wantCur)
			}
		})
	}
}

// ----------------------------------------------------------------------------
//  Engine: create / pay / get
// ----------------------------------------------------------------------------

func newTestEngine(t *testing.T) (*Engine, *MockConnector) {
	t.Helper()
	mc := NewMockConnector("mock")
	e := NewEngine(mc)
	return e, mc
}

func TestEngineLifecycle(t *testing.T) {
	t.Run("create session sets zero spend", func(t *testing.T) {
		e, _ := newTestEngine(t)
		s, err := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		if s.Spent.AmountAtomic != "0" || s.Payments != 0 {
			t.Errorf("fresh session should have 0 spent/0 payments, got %+v", s)
		}
		if s.Remaining().AmountAtomic != "10000000" {
			t.Errorf("remaining: got %s want 10000000", s.Remaining().AmountAtomic)
		}
	})

	t.Run("budget decrement single payment", func(t *testing.T) {
		e, mc := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})

		res, err := e.ProcessPayment(context.Background(), s.ID, usdc("1500000"), "0xabc")
		if err != nil {
			t.Fatalf("ProcessPayment: %v", err)
		}
		if res.TxHash == "" || res.Provider != "mock" || res.Recipient != "0xabc" {
			t.Errorf("unexpected settlement: %+v", res)
		}
		if len(mc.Calls) != 1 {
			t.Fatalf("connector should be called once, got %d", len(mc.Calls))
		}
		got, _ := e.GetSession(context.Background(), s.ID)
		if got.Spent.AmountAtomic != "1500000" {
			t.Errorf("spent: got %s want 1500000", got.Spent.AmountAtomic)
		}
		if got.Remaining().AmountAtomic != "8500000" {
			t.Errorf("remaining: got %s want 8500000", got.Remaining().AmountAtomic)
		}
		if got.Payments != 1 {
			t.Errorf("payments: got %d want 1", got.Payments)
		}
	})

	t.Run("multi-payment accounting", func(t *testing.T) {
		e, mc := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})

		amounts := []string{"1500000", "2500000", "1000000"} // total 5000000
		hashes := map[string]bool{}
		for i, a := range amounts {
			res, err := e.ProcessPayment(context.Background(), s.ID, usdc(a), "0xabc")
			if err != nil {
				t.Fatalf("payment %d (%s): %v", i, a, err)
			}
			if hashes[res.TxHash] {
				t.Errorf("payment %d produced a duplicate tx hash %s", i, res.TxHash)
			}
			hashes[res.TxHash] = true
		}
		got, _ := e.GetSession(context.Background(), s.ID)
		if got.Spent.AmountAtomic != "5000000" {
			t.Errorf("spent: got %s want 5000000", got.Spent.AmountAtomic)
		}
		if got.Remaining().AmountAtomic != "5000000" {
			t.Errorf("remaining: got %s want 5000000", got.Remaining().AmountAtomic)
		}
		if got.Payments != 3 || len(mc.Calls) != 3 {
			t.Errorf("expected 3 payments/calls, got payments=%d calls=%d", got.Payments, len(mc.Calls))
		}
	})

	t.Run("exact budget is allowed", func(t *testing.T) {
		e, _ := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("1500000")})
		if _, err := e.ProcessPayment(context.Background(), s.ID, usdc("1500000"), "0xabc"); err != nil {
			t.Fatalf("spending exactly the budget should succeed: %v", err)
		}
		got, _ := e.GetSession(context.Background(), s.ID)
		if got.Remaining().AmountAtomic != "0" {
			t.Errorf("remaining: got %s want 0", got.Remaining().AmountAtomic)
		}
	})

	t.Run("over-budget rejection single", func(t *testing.T) {
		e, mc := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("1000000")})
		_, err := e.ProcessPayment(context.Background(), s.ID, usdc("1500000"), "0xabc")
		if engineErrCode(err) != CodeOverBudget {
			t.Fatalf("expected over_budget, got %v", err)
		}
		if len(mc.Calls) != 0 {
			t.Errorf("connector must not be called when over budget, got %d calls", len(mc.Calls))
		}
		got, _ := e.GetSession(context.Background(), s.ID)
		if got.Spent.AmountAtomic != "0" || got.Payments != 0 {
			t.Errorf("rejected payment must not mutate session, got %+v", got)
		}
	})

	t.Run("over-budget rejection on cumulative spend", func(t *testing.T) {
		e, _ := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("3000000")})
		if _, err := e.ProcessPayment(context.Background(), s.ID, usdc("2000000"), "0xabc"); err != nil {
			t.Fatalf("first payment: %v", err)
		}
		// 2 already spent; another 2 would exceed the 3 budget.
		err := func() error {
			_, e2 := e.ProcessPayment(context.Background(), s.ID, usdc("2000000"), "0xabc")
			return e2
		}()
		if engineErrCode(err) != CodeOverBudget {
			t.Fatalf("expected over_budget on cumulative spend, got %v", err)
		}
		got, _ := e.GetSession(context.Background(), s.ID)
		if got.Spent.AmountAtomic != "2000000" || got.Payments != 1 {
			t.Errorf("over-budget must leave prior accounting intact, got %+v", got)
		}
	})

	t.Run("unknown session", func(t *testing.T) {
		e, _ := newTestEngine(t)
		_, err := e.ProcessPayment(context.Background(), "sess_nope", usdc("1"), "0xabc")
		if engineErrCode(err) != CodeSessionNotFound {
			t.Fatalf("expected session_not_found, got %v", err)
		}
		if _, gerr := e.GetSession(context.Background(), "sess_nope"); engineErrCode(gerr) != CodeSessionNotFound {
			t.Errorf("GetSession on unknown id: expected session_not_found, got %v", gerr)
		}
	})

	t.Run("currency mismatch rejected", func(t *testing.T) {
		e, mc := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})
		_, err := e.ProcessPayment(context.Background(), s.ID,
			Money{AmountAtomic: "1000000000000000000", Decimals: 18, Currency: "DAI"}, "0xabc")
		if engineErrCode(err) != CodeCurrencyMismatch {
			t.Fatalf("expected currency_mismatch, got %v", err)
		}
		if len(mc.Calls) != 0 {
			t.Errorf("connector must not be called on currency mismatch")
		}
	})

	t.Run("expired session rejected", func(t *testing.T) {
		clock := time.Now()
		e := NewEngine(NewMockConnector("mock"), WithClock(func() time.Time { return clock }))
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000"), ExpiryMinutes: 1})
		// Advance the clock past expiry.
		clock = s.ExpiresAt.Add(time.Second)
		_, err := e.ProcessPayment(context.Background(), s.ID, usdc("1000000"), "0xabc")
		if engineErrCode(err) != CodeSessionExpired {
			t.Fatalf("expected session_expired, got %v", err)
		}
	})

	t.Run("invalid atomic amount rejected", func(t *testing.T) {
		e, _ := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})
		_, err := e.ProcessPayment(context.Background(), s.ID,
			Money{AmountAtomic: "not-a-number", Decimals: 6, Currency: "USDC"}, "0xabc")
		if engineErrCode(err) != CodeInvalidAmount {
			t.Fatalf("expected invalid_amount, got %v", err)
		}
	})

	t.Run("negative atomic amount rejected", func(t *testing.T) {
		e, _ := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})
		_, err := e.ProcessPayment(context.Background(), s.ID,
			Money{AmountAtomic: "-5", Decimals: 6, Currency: "USDC"}, "0xabc")
		if engineErrCode(err) != CodeInvalidAmount {
			t.Fatalf("expected invalid_amount, got %v", err)
		}
	})

	t.Run("settlement failure leaves session untouched", func(t *testing.T) {
		e := NewEngine(&failConnector{provider: "fail"})
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})
		_, err := e.ProcessPayment(context.Background(), s.ID, usdc("1000000"), "0xabc")
		if err == nil {
			t.Fatal("expected settlement error, got nil")
		}
		got, _ := e.GetSession(context.Background(), s.ID)
		if got.Spent.AmountAtomic != "0" || got.Payments != 0 {
			t.Errorf("failed settlement must not mutate accounting, got %+v", got)
		}
	})
}

// ----------------------------------------------------------------------------
//  Wiring / config edge cases
// ----------------------------------------------------------------------------

func TestEngineConfig(t *testing.T) {
	t.Run("nil connector blocks create and pay", func(t *testing.T) {
		e := NewEngine(nil)
		if _, err := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("1")}); engineErrCode(err) != CodeNoConnector {
			t.Errorf("CreateSession: expected no_connector, got %v", err)
		}
		if _, err := e.ProcessPayment(context.Background(), "x", usdc("1"), "0xabc"); engineErrCode(err) != CodeNoConnector {
			t.Errorf("ProcessPayment: expected no_connector, got %v", err)
		}
	})

	t.Run("default expiry is 60 minutes", func(t *testing.T) {
		clock := time.Date(2026, 5, 30, 0, 0, 0, 0, time.UTC)
		e := NewEngine(NewMockConnector("mock"), WithClock(func() time.Time { return clock }))
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("1")})
		if !s.ExpiresAt.Equal(clock.Add(60 * time.Minute)) {
			t.Errorf("expected 60m expiry, got %s", s.ExpiresAt)
		}
	})

	t.Run("invalid budget rejected at create", func(t *testing.T) {
		e, _ := newTestEngine(t)
		if _, err := e.CreateSession(context.Background(), CreateSessionParams{Budget: Money{AmountAtomic: "xyz", Decimals: 6, Currency: "USDC"}}); engineErrCode(err) != CodeInvalidAmount {
			t.Errorf("expected invalid_amount, got %v", err)
		}
	})

	t.Run("custom session store is used", func(t *testing.T) {
		store := NewMemorySessionStore()
		e := NewEngine(NewMockConnector("mock"), WithSessionStore(store))
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("1")})
		if _, ok := store.Get(s.ID); !ok {
			t.Error("expected session to land in the injected store")
		}
	})

	t.Run("GetSession returns a copy", func(t *testing.T) {
		e, _ := newTestEngine(t)
		s, _ := e.CreateSession(context.Background(), CreateSessionParams{Budget: usdc("10000000")})
		got, _ := e.GetSession(context.Background(), s.ID)
		got.Spent = usdc("9999999") // mutate the returned copy
		fresh, _ := e.GetSession(context.Background(), s.ID)
		if fresh.Spent.AmountAtomic != "0" {
			t.Errorf("mutating the returned session leaked into the store: %+v", fresh)
		}
	})

	t.Run("mock connector deterministic hash", func(t *testing.T) {
		mc := NewMockConnector("mock")
		req := PaymentRequest{SessionID: "s1", Recipient: "0xabc", Amount: usdc("1000000")}
		r1, _ := mc.Settle(context.Background(), req)
		mc2 := NewMockConnector("mock")
		r2, _ := mc2.Settle(context.Background(), req)
		if r1.TxHash != r2.TxHash {
			t.Errorf("same first call should be deterministic: %s vs %s", r1.TxHash, r2.TxHash)
		}
		if r1.TxHash == "" || len(r1.TxHash) != 66 { // "0x" + 64 hex
			t.Errorf("unexpected tx hash shape: %q", r1.TxHash)
		}
	})
}
