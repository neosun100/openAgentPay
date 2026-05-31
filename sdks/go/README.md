# openagentpay-go

Go client SDK for [OpenAgentPay](https://github.com/neosun100/openAgentPay) — the "LiteLLM for Crypto Agent Payments." It's the thin remote HTTP client that talks to a running `oap-proxy` / `demo-api`, mirroring the TypeScript [`@openagentpay/sdk`](../../packages/sdk) wire shapes exactly.

- **Zero external dependencies** — stdlib `net/http` + `encoding/json` only.
- Idiomatic Go: `context.Context` first arg, `(T, error)` returns, functional options.
- Injectable `*http.Client` for testing and custom timeouts.

## Install

```bash
go get github.com/neosun100/openagentpay-go
```

## Usage

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	oap "github.com/neosun100/openagentpay-go"
)

func main() {
	// Empty baseURL falls back to the public demo endpoint.
	client := oap.NewClient(
		"https://d1p7yxa99nxaye.cloudfront.net",
		oap.WithAPIKey("oap_sk_..."),               // optional Bearer token
		oap.WithHTTPClient(&http.Client{Timeout: 10 * time.Second}), // optional
	)

	ctx := context.Background()

	// One-shot: create a session then pay under it (expiry defaults to 60 min).
	recipient := "0xRecipientAddress"
	res, err := client.PayOnce(ctx, oap.PayOnceRequest{
		BudgetUsd:  10,
		AmountUsdc: 1.5,
		Recipient:  &recipient,
	})
	if err != nil {
		// Non-2xx responses surface as *oap.APIError.
		var apiErr *oap.APIError
		if errors.As(err, &apiErr) {
			log.Fatalf("API error %d (%s): %s", apiErr.Status, apiErr.Code, apiErr.Message)
		}
		log.Fatal(err)
	}

	fmt.Printf("session=%s tx=%v\n", res.Session.SessionID, res.Payment.TxHash)

	// Or drive the session yourself:
	session, _ := client.CreateSession(ctx, oap.CreateSessionRequest{BudgetUsd: 20, ExpiryMinutes: 30})
	pay, _ := client.Pay(ctx, oap.PayRequest{SessionID: session.SessionID, AmountUsdc: 2})
	fmt.Println(pay.AmountAtomic, pay.WalletProvider)

	wallets, _ := client.ListWallets(ctx)
	fmt.Println("default wallet:", wallets.DefaultProvider)
}
```

## Methods

| Method | Route |
| --- | --- |
| `CreateSession(ctx, CreateSessionRequest)` | `POST /api/session` |
| `Pay(ctx, PayRequest)` | `POST /api/pay` |
| `GetSession(ctx, id)` | `GET /api/session/:id` |
| `ListWallets(ctx)` | `GET /api/wallets` |
| `GetGovernance(ctx)` | `GET /api/governance` |
| `GetAudit(ctx)` | `GET /api/governance/audit` |
| `PayOnce(ctx, PayOnceRequest)` | session + pay in one call |

## Errors

Any non-2xx response returns an `*APIError`:

```go
type APIError struct {
	Status  int    // HTTP status
	Code    string // machine code (server `error`/`errorCode`/`code`, else `http_<status>`)
	Message string // human-readable message
	Raw     string // raw response body
}
```

Use `errors.As(err, &apiErr)` to inspect it.

## License

Apache-2.0 — maintained by [Neo Sun](https://github.com/neosun100).
