# OpenAgentPay — Java SDK

The **client→proxy** half of OpenAgentPay's "LiteLLM for crypto agent payments" — a thin, dependency-light remote client for the `oap-proxy` / `demo-api` REST surface. Point it at a running proxy and execute payments in one line; no in-process wallet/protocol wiring.

This mirrors the TypeScript [`@openagentpay/sdk`](../../packages/sdk) exactly (same routes, same field shapes).

- **Java**: 17+
- **HTTP**: `java.net.http.HttpClient` (JDK built-in — no networking deps)
- **JSON**: Jackson databind (the only compile-scoped dependency)
- **License**: Apache-2.0

## Install (Maven)

```xml
<dependency>
  <groupId>com.openagentpay</groupId>
  <artifactId>openagentpay-sdk</artifactId>
  <version>0.10.0</version>
</dependency>
```

## Usage

```java
import com.openagentpay.sdk.OpenAgentPayClient;
import com.openagentpay.sdk.Models;
import com.openagentpay.sdk.OpenAgentPayApiException;

public class Demo {
    public static void main(String[] args) {
        OpenAgentPayClient client = OpenAgentPayClient.builder()
                .baseUrl("https://d1p7yxa99nxaye.cloudfront.net") // default; configurable
                .apiKey(System.getenv("OAP_API_KEY"))              // optional Bearer token
                .build();

        // 1) Open a budgeted session, then pay under it.
        Models.SessionResponse session = client.createSession(
                new Models.CreateSessionRequest(/* budgetUsd */ 5.0, /* expiryMinutes */ 60));

        Models.PayResponse payment = client.pay(
                new Models.PayRequest(session.sessionId(), /* amountUsdc */ 0.5));

        if (payment.success()) {
            System.out.println("Paid! tx=" + payment.txHash()
                    + " explorer=" + payment.explorerUrl());
        }

        // 2) One-shot convenience: create session + pay in a single call
        //    (expiryMinutes defaults to 60).
        Models.PayOnceResult once = client.payOnce(
                new Models.PayOnceRequest(/* budgetUsd */ 3.0, /* amountUsdc */ 1.5));
        System.out.println("payOnce session=" + once.session().sessionId()
                + " success=" + once.payment().success());

        // 3) Discover wallets.
        Models.WalletsResponse wallets = client.listWallets();
        System.out.println("default wallet = " + wallets.defaultProvider());
        wallets.wallets().forEach(w ->
                System.out.println("  " + w.walletProvider() + " on " + w.chainName()));

        // 4) Governance + audit (server-defined shapes → Jackson JsonNode).
        System.out.println("governance = " + client.getGovernance());
        System.out.println("audit      = " + client.getAudit());

        // 5) Typed errors on any non-2xx.
        try {
            client.getSession("does-not-exist");
        } catch (OpenAgentPayApiException e) {
            System.out.println("status=" + e.status()
                    + " code=" + e.code()
                    + " message=" + e.getMessage());
        }
    }
}
```

## Methods

| Method | Route | Returns |
| --- | --- | --- |
| `createSession(CreateSessionRequest)` | `POST /api/session` | `SessionResponse` |
| `pay(PayRequest)` | `POST /api/pay` | `PayResponse` |
| `getSession(String id)` | `GET /api/session/:id` | `SessionResponse` (throws on 404) |
| `listWallets()` | `GET /api/wallets` | `WalletsResponse` |
| `getGovernance()` | `GET /api/governance` | `JsonNode` |
| `getAudit()` | `GET /api/governance/audit` | `JsonNode` |
| `payOnce(PayOnceRequest)` | session + pay | `PayOnceResult` |

`PayRequest` and `PayOnceRequest` have convenience constructors that omit the optional `recipient` / `walletProvider`; omitted fields are not sent on the wire.

## Errors

Any non-2xx response throws `OpenAgentPayApiException` carrying:

- `status()` — HTTP status code
- `code()` — server-supplied machine code (`errorCode`/`code`/`error`), else `http_<status>`
- `getMessage()` — human-readable message (`error` / `message` from the body, or the raw text)
- `raw()` — the raw response body for forensics

## Build & test

This SDK lives in `sdks/java`, **outside** the pnpm/uv workspaces, so it never affects the JS/Python build.

```bash
cd sdks/java
mvn -q -B test
```

Tests are fully network-free: they run a JDK-built-in `com.sun.net.httpserver.HttpServer` on an ephemeral localhost port and drive the real `java.net.http` client against it.
