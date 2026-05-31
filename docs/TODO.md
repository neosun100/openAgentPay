# 📋 OpenAgentPay — Active TODO List

> **Always-up-to-date sprint tasks.** If you finish anything, mark it ✅. If you discover a new task, add it under the right lane.
>
> See [`STATE.md`](./STATE.md) for the resumable-state entry point.
> See [`ROADMAP.md`](./ROADMAP.md) for the quarterly arc.

---

## 🚦 Three lanes — pick what you want to work on

| Lane | Description | Depends on you (Neo)? |
|---|---|---|
| **A. Wallet integrations** | Real testnet wallets to round out the 18-protocol matrix | ✅ Yes — you must register accounts |
| **B. Self-contained polish** | Improvements that don't need external accounts | ❌ No — I can do alone |
| **C. Ecosystem expansion** | New plugins / SDKs / protocols / governance | ❌ No |

---

## Lane A — v0.11 Wallet Integrations — ✅ SHIPPED (connectors built, conformance-green)

> **v0.11 unlocked these WITHOUT requiring Neo to register anything**: each
> connector generates a real testnet keypair in-process and passes all 25
> conformance tests offline + LIVE. The only remaining Lane-A work is *funding*
> the generated keypairs from public faucets to land real on-chain txs (purely
> a proof-layer nicety — the connectors are already production-shaped).

### Tier A — built & conformance-green (Round 1)

| Status | Wallet | Conformance | Live-tx proof (optional) |
|---|---|---|---|
| ✅ done | **wallet-stellar** | 25/25 ✓ | fund `G…` via Friendbot |
| ✅ done | **wallet-hedera** | 25/25 ✓ | fund `0.0.x` via portal faucet |
| ✅ done | **wallet-sui** | 25/25 ✓ | `sui client faucet` |
| ✅ done | **wallet-aptos** | 25/25 ✓ | `aptos account fund-with-faucet` |
| ✅ done | **wallet-tron** | 25/25 ✓ | Shasta faucet |
| ✅ done | **wallet-cosmos** | 25/25 ✓ | Theta faucet |
| ✅ done | **wallet-solana** (real signer) | 25/25 ✓ | `solana airdrop` devnet |

### Tier B — built & conformance-green (Round 2)

| Status | Wallet | Conformance | Notes |
|---|---|---|---|
| ✅ done | **wallet-stripe-privy** | 25/25 ✓ | closes AgentCore Path-D parity |
| ✅ done | **wallet-circle** | 25/25 ✓ | USDC-native + gas-station flag |
| ✅ done | **wallet-magic** | 25/25 ✓ | email-bound EVM wallet |
| ✅ done | **wallet-zerodev** | 25/25 ✓ | ERC-4337 smart account |
| ⏳ later | **wallet-lightning** | — | needs live Voltage LND (no offline keygen path) |
| ⏳ later | **wallet-open-payments** | — | needs Rafiki client keys |

### What I do once you give me credentials

For each wallet, the deliverable workflow is:

1. **Implement** `packages/wallet-<name>/` against existing `WalletConnector` interface
2. **Conformance** — wire `runWalletConformance()` from `@openagentpay/conformance` into the test file (must pass all 25 tests)
3. **Smoke test** — write `scripts/<name>-smoke.ts` that does a real testnet tx
4. **CHANGELOG entry** with the testnet tx hash + explorer link as proof
5. **Update demo-web** capability bar to surface the new wallet
6. **Update `docs/STATE.md` Round 1/2 status** to ✅

---

## Lane B — Self-contained polish (no external dependencies)

I can do these without you needing to register anything.

### B1 — Migrate `apps/demo-api` to register all wallets
- **Status**: ✅ done (v0.11) — `buildSelfContainedBundles()` registers all 11
  new connectors; `/api/wallets` returns 13 live wallets.

### B2 — GitHub Actions CI
- **Status**: ✅ done (v0.11) — `.github/workflows/ci.yml` (TS build+test,
  wallet conformance offline+LIVE, Python pytest). README CI badge added.
  Bonus: fixed `uv sync` (missing pydantic-ai-plugin README).

### B3 — `oap` CLI: `pay` and `session` subcommands
- **Status**: ⏳ pending
- **Why**: Today the CLI has config / doctor / conformance / version. Missing the actual "make a payment" + "create session" interactive commands that LiteLLM has via `litellm pay`.
- **Effort**: ~3 hr
- **Acceptance**: `oap pay --to <addr> --amount 1.5USDC --wallet hashkey` works against the local proxy

### B4 — Python SDK: full client (not just types)
- **Status**: ⏳ pending
- **Why**: `packages/python-sdk` only has `types.py`. Mirror the TS `PaymentManager` API for Python users who don't want a framework plugin.
- **Effort**: ~4 hr
- **Acceptance**: `from openagentpay import PaymentManager` works; basic `process_payment()` flow against demo-api

### B5 — More framework plugins (Python)
- **Status**: ⏳ pending
- Possible candidates: `bedrock-agentcore-plugin` (deep AWS integration), `dspy-plugin`, `instructor-plugin`
- **Effort**: ~3 hr each (each plugin is a small shim over the framework-agnostic kernel)

### B6 — Refund / Subscription productization
- **Status**: ✅ done (v0.11) — `PaymentManager.refund()` + settled-payment
  ledger guards; `InMemorySubscriptionManager` BigInt credit ledger; `Receipt`
  issuance + HMAC sign/verify. 39+ new core tests.

### B7 — `@openagentpay/http-interceptor` (LiteLLM-style auto-402-retry axios/fetch)
- **Status**: ✅ done (v0.11) — `wrapFetch` / `wrapAxios`, dependency-light,
  duck-typed. 14 tests.

### B8 — S3 WORM AuditSink
- **Status**: ⏳ pending
- **Why**: For SOX/MRM compliance, audit log must be Write-Once-Read-Many. DynamoDB is queryable but mutable. S3 with Object Lock is true WORM.
- **Effort**: ~3 hr
- **Acceptance**: New class `S3WormAuditSink` in `packages/governance/src/sinks/`, with object-lock retention period config

### B9 — `oap audit` CLI subcommand
- **Status**: ⏳ pending
- **Why**: Read audit logs from CLI without opening browser
- **Effort**: ~1 hr
- **Acceptance**: `oap audit --since 2024-01-01 --kind payment_success` queries the audit sink

### B10 — Spend Analytics Tab v2 — charts
- **Status**: ⏳ pending
- **Why**: Today it's tables. Add a small SVG sparkline for "spend over time" + a pie for wallet share.
- **Effort**: ~2 hr (no library — hand-rolled SVG)

---

## Lane C — Ecosystem expansion (longer-term, I'd pick these last)

### C1 — Java SDK (`com.openagentpay.sdk`)
- **Status**: 🔒 backlog
- **Why**: Spring AI / LangChain4j users — large enterprise market
- **Effort**: ~12 hr (fresh ground-up port)

### C2 — Go SDK (`github.com/openagentpay/sdk-go`)
- **Status**: 🔒 backlog
- **Why**: Cloud / infrastructure programs use Go
- **Effort**: ~10 hr

### C3 — Rust SDK
- **Status**: 🔒 backlog
- **Effort**: ~10 hr (rig.rs / kalosm integration target)

### C4 — OAP-CEX 2nd implementation (validates protocol, not just Binance-shape)
- **Status**: 🔒 backlog (depends on you registering OKX or HashKey Pro)
- **Effort**: ~6 hr per CEX

### C5 — AP2 v0.2 A2A discovery
- **Status**: 🔒 backlog (waits on AP2 spec finalization)
- **Effort**: ~5 hr
- **Why**: Cross-agent payment with capability discovery — google's roadmap item

### C6 — Cobo Agentic Wallet integration
- **Status**: 🔒 deferred (review-required at Cobo)
- **Effort**: ~6 hr after credentials

### C7 — Stripe MPP v2 (when published)
- **Status**: 🔒 backlog
- **Why**: Watch IETF draft progress

### C8 — Federated Conformance — third-party-ran tests
- **Status**: 🔒 backlog
- **Why**: Imagine a public dashboard `oapconformance.io` where any community wallet can submit a PR and get auto-tested. The Linux Foundation playbook.

### C9 — Spend Analytics: anomaly detection (ML)
- **Status**: 🔒 backlog
- **Why**: Detect compromised agents by spend pattern deviation
- **Effort**: ~10 hr (basic z-score baseline)

### C10 — `oap proxy` cluster mode
- **Status**: 🔒 backlog
- **Why**: For high-throughput multi-tenant SaaS — DynamoDB-backed TenantStore, shared session/audit state
- **Effort**: ~8 hr

---

## ✅ Already done (recent — for context)

(See `CHANGELOG.md` for the full history.)

- v0.10.0 (2026-05-24) — CLI · config yaml · WalletRouter · finance types · governance v0.10 (Chainalysis/TRM/OFAC/Approval/PerAgent/Jurisdiction) · 5 new protocols · 3 new framework plugins · proxy yaml-bootstrap · demo-web Spend Analytics · wallet-hashkey conformance (caught real bug)
- v0.9.0 (2026-05-24) — `@openagentpay/proxy` · `@openagentpay/conformance` · `docs/POSITIONING.md`
- v0.8.0 (2026-05-21) — Multi-protocol composition + Framework Plugin matrix + 4 wallet additions
- v0.7.0 (2026-05-20) — DynamoDB SessionManager
- v0.6.0 (2026-05-20) — DynamoDB AuditSink
- v0.5.x (2026-05-19) — LangChain plugin · Strands plugin
- v0.4.x (2026-05-19) — 7-Layer Guardrail
- v0.3.0 (2026-05-19) — Path-D Hybrid (Coinbase CDP + HashKey side-by-side)
- v0.2.0 (2026-05-17) — AWS Live deployment
- v0.1.0 (2026-05-17) — MVP

---

## 📈 Progress meter

```
v0.11 wallet integration matrix:
[████████████████████] 28 wallets · 18/18 protocols    ✅ v0.11.1 breadth pass complete

v1.0 readiness (subjective):
[██████████████████░░] 90%
   - Core abstractions: 100%
   - Wallet coverage:   90%   ← was the biggest gap, now closed
   - Protocol coverage: 95%   (+ protocol conformance v2)
   - Plugin coverage:   80%
   - Productization:    95%   (refund/subscription/receipt/interceptor)
   - Compliance/gov:    80%
   - CI/CD:             100%  (was 0%)
```

---

*Last updated: 2026-05-31 — v0.11.1 breadth pass (2045 tests, 28 wallets, 18/18 protocols conformance)*
*Update protocol: when a task moves status, update the row + bump the "Last updated" line.*
