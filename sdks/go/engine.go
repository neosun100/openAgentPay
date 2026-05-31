package openagentpay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"
)

// ============================================================================
//  In-process payment engine
//
//  This is the "in-process" half of the LiteLLM analogy — the counterpart to
//  Client, which talks to a remote proxy over HTTP. Engine mirrors the TS core
//  PaymentManager surface (CreateSession / ProcessPayment / GetSession) WITHOUT
//  any network call: sessions live in-memory and settlement is delegated to a
//  pluggable Connector. All money math is atomic-unit only (math/big.Int).
//
//  License: Apache-2.0
// ============================================================================

// Money is the canonical atomic-unit money value used throughout the engine.
// AmountAtomic is the integer amount in the smallest unit (e.g. "1500000" for
// 1.5 USDC at 6 decimals), kept as a string so it survives JSON without
// precision loss. Float is never used for money.
type Money struct {
	AmountAtomic string `json:"amountAtomic"`
	Decimals     int    `json:"decimals"`
	Currency     string `json:"currency"`
}

// PaymentRequest is what the engine hands a Connector to settle.
type PaymentRequest struct {
	SessionID string
	Amount    Money
	Recipient string
}

// SettlementResult is what a Connector returns on a successful settlement.
type SettlementResult struct {
	TxHash    string
	Provider  string
	Recipient string
	Amount    Money
}

// Connector is the in-process settlement backend. Implementations move value
// for a single provider (chain RPC, CEX REST, mock, …).
type Connector interface {
	// Settle executes (or simulates) a single payment and returns the result.
	Settle(ctx context.Context, req PaymentRequest) (SettlementResult, error)
	// Provider is the stable provider id, e.g. "hashkey" or "mock".
	Provider() string
}

// ============================================================================
//  Errors — mirror the errors.go typed-struct style.
// ============================================================================

// EngineError is the typed error surface for the in-process engine. Code is a
// stable machine code; Message is human-readable.
type EngineError struct {
	Code    string
	Message string
}

// Error implements the error interface.
func (e *EngineError) Error() string {
	return fmt.Sprintf("openagentpay: %s: %s", e.Code, e.Message)
}

// Sentinel error codes for errors.As / equality checks via Code.
const (
	CodeSessionNotFound  = "session_not_found"
	CodeOverBudget       = "over_budget"
	CodeSessionExpired   = "session_expired"
	CodeInvalidAmount    = "invalid_amount"
	CodeCurrencyMismatch = "currency_mismatch"
	CodeNoConnector      = "no_connector"
)

func newEngineError(code, format string, args ...any) *EngineError {
	return &EngineError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ============================================================================
//  Session + store
// ============================================================================

// Session is a budgeted spending session. Budget and Spent are atomic-unit
// money in the session's currency. Remaining = Budget - Spent.
type Session struct {
	ID        string
	Budget    Money
	Spent     Money
	Payments  int
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Remaining returns Budget - Spent as a Money value in the session currency.
func (s *Session) Remaining() Money {
	budget := mustBig(s.Budget.AmountAtomic)
	spent := mustBig(s.Spent.AmountAtomic)
	rem := new(big.Int).Sub(budget, spent)
	return Money{AmountAtomic: rem.String(), Decimals: s.Budget.Decimals, Currency: s.Budget.Currency}
}

// SessionStore persists sessions for an Engine. Implementations must be safe
// for concurrent use.
type SessionStore interface {
	Put(s *Session)
	Get(id string) (*Session, bool)
}

// MemorySessionStore is an in-memory, mutex-guarded SessionStore.
type MemorySessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewMemorySessionStore builds an empty in-memory store.
func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{sessions: make(map[string]*Session)}
}

// Put stores (or replaces) a session by id.
func (m *MemorySessionStore) Put(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[s.ID] = s
}

// Get fetches a session by id.
func (m *MemorySessionStore) Get(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	return s, ok
}

// ============================================================================
//  Engine
// ============================================================================

// Engine is the in-process PaymentManager. It coordinates a SessionStore with
// a Connector and enforces budget accounting in atomic units.
type Engine struct {
	store     SessionStore
	connector Connector
	mu        sync.Mutex // serializes ProcessPayment read-modify-write per engine
	now       func() time.Time
	idSeq     int
}

// EngineOption configures an Engine.
type EngineOption func(*Engine)

// WithSessionStore injects a custom SessionStore (defaults to MemorySessionStore).
func WithSessionStore(store SessionStore) EngineOption {
	return func(e *Engine) {
		if store != nil {
			e.store = store
		}
	}
}

// WithClock injects a custom time source (useful for deterministic expiry tests).
func WithClock(now func() time.Time) EngineOption {
	return func(e *Engine) {
		if now != nil {
			e.now = now
		}
	}
}

// NewEngine builds an Engine bound to a Connector. The connector is required;
// CreateSession/ProcessPayment return a no_connector error if it is nil.
func NewEngine(connector Connector, opts ...EngineOption) *Engine {
	e := &Engine{
		store:     NewMemorySessionStore(),
		connector: connector,
		now:       time.Now,
	}
	for _, opt := range opts {
		opt(e)
	}
	if e.store == nil {
		e.store = NewMemorySessionStore()
	}
	if e.now == nil {
		e.now = time.Now
	}
	return e
}

// CreateSessionParams opens an in-process session with an atomic-unit budget.
type CreateSessionParams struct {
	Budget        Money
	ExpiryMinutes int // <= 0 defaults to 60
}

// CreateSession opens a budgeted session. The budget currency/decimals become
// the session's; payments in other currencies are rejected.
func (e *Engine) CreateSession(ctx context.Context, p CreateSessionParams) (*Session, error) {
	if e.connector == nil {
		return nil, newEngineError(CodeNoConnector, "engine has no connector configured")
	}
	if _, err := validateAtomic(p.Budget); err != nil {
		return nil, err
	}

	expiry := p.ExpiryMinutes
	if expiry <= 0 {
		expiry = 60
	}

	e.mu.Lock()
	e.idSeq++
	seq := e.idSeq
	e.mu.Unlock()

	now := e.now()
	s := &Session{
		ID:     fmt.Sprintf("sess_%d_%d", now.UnixNano(), seq),
		Budget: p.Budget,
		Spent: Money{
			AmountAtomic: "0",
			Decimals:     p.Budget.Decimals,
			Currency:     p.Budget.Currency,
		},
		CreatedAt: now,
		ExpiresAt: now.Add(time.Duration(expiry) * time.Minute),
	}
	e.store.Put(s)
	return s, nil
}

// ProcessPayment settles a payment under an existing session, decrementing its
// budget. It rejects unknown sessions, expired sessions, currency mismatches,
// and over-budget requests with typed *EngineError values.
func (e *Engine) ProcessPayment(ctx context.Context, sessionID string, amount Money, recipient string) (SettlementResult, error) {
	var zero SettlementResult
	if e.connector == nil {
		return zero, newEngineError(CodeNoConnector, "engine has no connector configured")
	}

	amtBig, err := validateAtomic(amount)
	if err != nil {
		return zero, err
	}

	// Serialize the read-modify-write so concurrent payments can't both pass
	// the budget check against the same pre-decrement balance.
	e.mu.Lock()
	defer e.mu.Unlock()

	s, ok := e.store.Get(sessionID)
	if !ok {
		return zero, newEngineError(CodeSessionNotFound, "session %q not found", sessionID)
	}
	if amount.Currency != s.Budget.Currency {
		return zero, newEngineError(CodeCurrencyMismatch,
			"payment currency %q does not match session currency %q", amount.Currency, s.Budget.Currency)
	}
	if !e.now().Before(s.ExpiresAt) {
		return zero, newEngineError(CodeSessionExpired, "session %q expired at %s", sessionID, s.ExpiresAt.Format(time.RFC3339))
	}

	budget := mustBig(s.Budget.AmountAtomic)
	spent := mustBig(s.Spent.AmountAtomic)
	next := new(big.Int).Add(spent, amtBig)
	if next.Cmp(budget) > 0 {
		remaining := new(big.Int).Sub(budget, spent)
		return zero, newEngineError(CodeOverBudget,
			"payment of %s exceeds remaining budget %s (currency %s)",
			amount.AmountAtomic, remaining.String(), s.Budget.Currency)
	}

	// Settle via the connector. On failure, the session is left untouched.
	res, err := e.connector.Settle(ctx, PaymentRequest{
		SessionID: sessionID,
		Amount:    amount,
		Recipient: recipient,
	})
	if err != nil {
		return zero, err
	}

	// Commit accounting only after a successful settlement.
	s.Spent = Money{AmountAtomic: next.String(), Decimals: s.Budget.Decimals, Currency: s.Budget.Currency}
	s.Payments++
	e.store.Put(s)

	return res, nil
}

// GetSession returns a copy of the named session, or a typed not-found error.
func (e *Engine) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	s, ok := e.store.Get(sessionID)
	if !ok {
		return nil, newEngineError(CodeSessionNotFound, "session %q not found", sessionID)
	}
	cp := *s
	return &cp, nil
}

// ============================================================================
//  Amount parsing — "1.5USDC" -> {AmountAtomic:"1500000", Decimals:6, Currency:"USDC"}
// ============================================================================

// currencyDecimals maps a known currency symbol to its on-chain decimals.
var currencyDecimals = map[string]int{
	"USDC": 6,
	"USDT": 6,
	"DAI":  18,
	"ETH":  18,
	"WETH": 18,
	"BTC":  8,
}

// ParseAmount parses a human amount like "1.5USDC", "0.000001 USDC" or
// "10 DAI" into atomic-unit Money. Whitespace between number and currency is
// optional. The currency must be known (see currencyDecimals) so the correct
// decimals are applied; an unknown or malformed input returns an
// invalid_amount EngineError.
func ParseAmount(s string) (Money, error) {
	var zero Money
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return zero, newEngineError(CodeInvalidAmount, "empty amount")
	}

	// Split the leading numeric run from the trailing currency symbol.
	i := 0
	for i < len(trimmed) {
		ch := trimmed[i]
		if (ch >= '0' && ch <= '9') || ch == '.' {
			i++
			continue
		}
		break
	}
	numPart := trimmed[:i]
	curPart := strings.TrimSpace(trimmed[i:])

	if numPart == "" {
		return zero, newEngineError(CodeInvalidAmount, "no numeric part in %q", s)
	}
	if curPart == "" {
		return zero, newEngineError(CodeInvalidAmount, "no currency in %q", s)
	}
	currency := strings.ToUpper(curPart)
	decimals, ok := currencyDecimals[currency]
	if !ok {
		return zero, newEngineError(CodeInvalidAmount, "unknown currency %q in %q", curPart, s)
	}

	atomic, err := toAtomic(numPart, decimals)
	if err != nil {
		return zero, newEngineError(CodeInvalidAmount, "invalid number %q: %s", numPart, err)
	}
	return Money{AmountAtomic: atomic, Decimals: decimals, Currency: currency}, nil
}

// toAtomic converts a decimal string like "1.5" with N decimals into the
// atomic integer string ("1500000" for decimals=6). It rejects multiple dots
// and fractional precision beyond `decimals`.
func toAtomic(num string, decimals int) (string, error) {
	parts := strings.Split(num, ".")
	if len(parts) > 2 {
		return "", fmt.Errorf("multiple decimal points")
	}
	intPart := parts[0]
	fracPart := ""
	if len(parts) == 2 {
		fracPart = parts[1]
	}
	if intPart == "" && fracPart == "" {
		return "", fmt.Errorf("no digits")
	}
	if intPart == "" {
		intPart = "0"
	}
	if len(fracPart) > decimals {
		return "", fmt.Errorf("more than %d fractional digits", decimals)
	}
	// Right-pad the fraction to exactly `decimals` digits.
	fracPadded := fracPart + strings.Repeat("0", decimals-len(fracPart))

	combined := intPart + fracPadded
	// big.Int parsing also validates that every char is a digit.
	v, ok := new(big.Int).SetString(combined, 10)
	if !ok {
		return "", fmt.Errorf("non-numeric digits")
	}
	if v.Sign() < 0 {
		return "", fmt.Errorf("negative amount")
	}
	return v.String(), nil
}

// validateAtomic ensures a Money carries a non-negative base-10 integer atomic
// amount and returns it as a *big.Int.
func validateAtomic(m Money) (*big.Int, error) {
	v, ok := new(big.Int).SetString(strings.TrimSpace(m.AmountAtomic), 10)
	if !ok {
		return nil, newEngineError(CodeInvalidAmount, "amountAtomic %q is not a base-10 integer", m.AmountAtomic)
	}
	if v.Sign() < 0 {
		return nil, newEngineError(CodeInvalidAmount, "amountAtomic %q is negative", m.AmountAtomic)
	}
	return v, nil
}

// mustBig parses a known-good atomic string (already validated). Falls back to
// zero on an empty/garbage value so accounting math never panics.
func mustBig(s string) *big.Int {
	v, ok := new(big.Int).SetString(strings.TrimSpace(s), 10)
	if !ok {
		return big.NewInt(0)
	}
	return v
}

// ============================================================================
//  MockConnector — deterministic settlement for tests/local dev.
// ============================================================================

// MockConnector is a trivial Connector that never touches a network and emits
// a deterministic tx hash derived from the request. It records every settled
// PaymentRequest for assertions.
type MockConnector struct {
	provider string
	mu       sync.Mutex
	Calls    []PaymentRequest
}

// NewMockConnector builds a MockConnector. An empty provider defaults to "mock".
func NewMockConnector(provider string) *MockConnector {
	if provider == "" {
		provider = "mock"
	}
	return &MockConnector{provider: provider}
}

// Provider returns the connector's provider id.
func (m *MockConnector) Provider() string { return m.provider }

// Settle records the request and returns a deterministic tx hash so the same
// (session, recipient, amount, call-index) always yields the same hash.
func (m *MockConnector) Settle(ctx context.Context, req PaymentRequest) (SettlementResult, error) {
	m.mu.Lock()
	idx := len(m.Calls)
	m.Calls = append(m.Calls, req)
	m.mu.Unlock()

	seed := fmt.Sprintf("%s|%s|%s|%d", req.SessionID, req.Recipient, req.Amount.AmountAtomic, idx)
	sum := sha256.Sum256([]byte(seed))
	return SettlementResult{
		TxHash:    "0x" + hex.EncodeToString(sum[:]),
		Provider:  m.provider,
		Recipient: req.Recipient,
		Amount:    req.Amount,
	}, nil
}
