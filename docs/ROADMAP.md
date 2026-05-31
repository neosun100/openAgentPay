# 🗺️ OpenAgentPay — Roadmap

> **Quarterly arc from where we are (v0.10) to v1.0 GA.**
>
> See [`STATE.md`](./STATE.md) for the resumable-state entry point.
> See [`TODO.md`](./TODO.md) for current-sprint granular tasks.

---

## 📅 Time-boxed releases

| Release | Theme | Dates | Status |
|---|---|---|---|
| v0.10 | LiteLLM-shape product complete | shipped 2026-05-24 | ✅ |
| **v0.11** | **Wallet matrix: 6 → 28 connectors + 18/18 protocol conformance** | shipped 2026-05-31 | ✅ |
| v0.12 | Refund/Subscription/Receipt productization | 2026 Q3 | ✅ pulled into v0.11 (core primitives) |
| v0.13 | Multi-language SDKs (Python full / Go / Java) | 2026 Q3-Q4 | 📅 planned |
| v0.14 | OAP-CEX 2nd impl + AP2 v0.2 + ERC-8004 v2 | 2026 Q4 | 🚧 protocol conformance v2 done in v0.11 |
| v0.15 | Federated conformance, public certifier dashboard | 2027 Q1 | 📅 planned |
| v0.16 | Anomaly detection + ML-based spend anomalies | 2027 Q1 | 📅 planned |
| **v1.0 GA** | **Production-ready, mainnet-blessed, SOC-2 path** | 2027 Q2 | 🎯 |

---

## 🎯 v0.11 — "Wallet matrix complete" (current focus)

### Goal

After v0.11, **every one of OpenAgentPay's 18 protocols has at least one real, testnet-verified wallet integration**. The "switch any wallet with one config-line" claim becomes literal: change `walletProvider` in yaml, the agent now uses Lightning instead of Coinbase, or Stellar instead of Solana — same business code.

### Scope

| Wallet to add | Protocol unlocked | Round | Status |
|---|---|---|---|
| `wallet-stellar` | stellar-sep31-v1 | A | ⏳ |
| `wallet-hedera` | hedera-hcs-v1 | A | ⏳ |
| `wallet-sui` | sui-pay-v1 | A | ⏳ |
| `wallet-aptos` | aptos-pay-v1 | A | ⏳ |
| `wallet-tron` | tron-usdt-v1 | A | ⏳ |
| `wallet-cosmos` | cosmos-ibc-v1 | A | ⏳ |
| upgrade `wallet-solana` | solana-pay-v1 (real signer) | A | ⏳ |
| `wallet-lightning` | l402-v1 | B | ⏳ |
| `wallet-open-payments` | open-payments-v1 | B | ⏳ |
| `wallet-stripe-privy` | x402-v1 (closes AgentCore Path-D) | B | ⏳ |
| `wallet-circle-pw` | x402-v1 (USDC native + gas station) | B | ⏳ |
| `wallet-magic` | x402-v1 (mainstream user wallet) | B | ⏳ |
| `wallet-zerodev` | x402-v1 (smart account) | B | ⏳ |

**v0.11 ship gate**:
- ≥ 13 new wallets implemented
- Each passes the 25-test conformance suite
- Each has a real testnet tx hash in CHANGELOG
- demo-web capability bar shows them all live

### Dependencies

The hard dep is **you (Neo) registering the testnet accounts**. See [`WALLET-SIGNUP-PLAN.md`](./WALLET-SIGNUP-PLAN.md) and [`TODO.md`](./TODO.md) Lane A.

---

## 🎯 v0.12 — "Financial primitives productized"

### Goal

Today `core/finance/types.ts` defines `Receipt`, `RefundRequest`, `Subscription`, etc — but they're types only, not wired into `PaymentManager`. v0.12 makes them first-class.

### Scope

- **`PaymentManager.refund(req)`** — works for x402 + select CEX wallets
- **`SubscriptionManager`** — credit ledger backed by DynamoDB; auto-renew option; pluggable into nevermined-v1 protocol
- **`Receipt` issuance** — every successful payment produces a merchant-signed Receipt (or unsigned if merchant doesn't sign), stored in audit log
- **`IdempotencyStore` integration** — every `POST /v1/payments` accepts `Idempotency-Key` header
- **`FxOracle` integration** — multi-asset budgets ("$100 daily cap" computed from any asset's USD value)
- **`PaymentSponsor` integration** — `sponsoredBy: "circle-gas-station"` config option
- **HTTP interceptor** — `wrapAxios` / `wrapFetch` for client-side auto-402-retry

### v0.12 ship gate

- 5+ refund tests passing across wallet types
- Subscription manager + DynamoDB persistence + auto-renew tested
- Receipt schema standardized + signed receipts on coinbase-cdp
- `oap pay` CLI command supports idempotency keys
- HTTP interceptor demo against demo-api

---

## 🎯 v0.13 — "Multi-language SDKs"

### Goal

Today's full SDK is TypeScript. Python has plugins (frame-shaped) but no full client SDK. Java/Go/Rust have nothing. v0.13 closes that.

### Scope

- **`@openagentpay/python-sdk`** v2 — full `PaymentManager` Python class (not just `types.py`); same surface as TS
- **`com.openagentpay.sdk`** Java — Maven Central published; Spring Boot starter
- **`github.com/openagentpay/sdk-go`** — Go SDK with idiomatic `context.Context` patterns
- **`crates.io openagentpay`** — Rust SDK; rig.rs integration

Each SDK ships with:
- Same conformance test contract (re-implemented per language but tests same behaviors)
- Quickstart in language docs
- Working agent demo (LangChain Python / Spring AI Java / rig.rs Rust)

### v0.13 ship gate

- All 4 SDKs published to their language registries
- Each has ≥ 1 working agent example
- All can connect to the same `oap-proxy` instance (proves the wire protocol is language-neutral)

---

## 🎯 v0.14 — "Protocol layer maturation"

### Goal

Today's protocol layer is structurally complete (18 adapters) but some are first-implementation-only. v0.14 hardens.

### Scope

- **OAP-CEX 2nd implementation** (OKX or HashKey Pro) — validates protocol design isn't Binance-specific
- **AP2 v0.2** A2A discovery integration — agents discover each other's payment capabilities via Google's registry
- **ERC-8004 v2** if specced — track upstream
- **MPP v0.2** — Stripe + Tempo's published draft
- **Solana Pay v2** if Phantom updates spec
- **Conformance suite v2** — adds protocol-level conformance for AP2/MPP/L402 (we have it for x402/cex-pay only today)

### v0.14 ship gate

- Every "live" protocol has ≥ 2 wallet implementations (proves the protocol is general)
- AP2 v0.2 A2A discovery demoed in demo-web (one agent paying another via mandate chain)
- Conformance suite catches at least one real protocol bug (similar to wallet-hashkey moment)

---

## 🎯 v0.15 — "Federated conformance certifier"

### Goal

Become the Linux Foundation of agent payments — not by writing every connector ourselves, but by being the certifier.

### Scope

- **`oapconformance.io`** public website
- Third parties submit a PR with their connector → automated CI runs the conformance suite → public dashboard shows pass/fail with timestamp
- "OpenAgentPay Certified" badge issuance (signed JSON receipts)
- Certificate revocation when conformance breaks
- Searchable directory of all certified wallets/protocols

### v0.15 ship gate

- ≥ 5 third-party PRs from outside neosun100 / OpenAgentPay org
- Public dashboard live
- Badge system working with cryptographic signatures

---

## 🎯 v0.16 — "Anomaly detection + ML"

### Goal

Move beyond rule-based governance (today's PolicyEngine) into pattern-based.

### Scope

- **Spend anomaly detector** — flags unusual spend patterns (z-score baseline + per-agent learned model)
- **Compromised-agent detection** — sudden recipient diversity spike, sudden amount jump, off-pattern time-of-day
- **Auto-suspend** — when anomaly score crosses threshold, ApprovalManager flips agent to "pending review"
- **Per-agent learned policies** — instead of static `amountThreshold(maxAtomic)`, learn typical spend pattern and alert on deviation

### v0.16 ship gate

- Demo with deliberately compromised agent that spends 100× normal — anomaly detector catches it within 3 transactions
- ApprovalManager auto-pauses + emits SNS notification
- False-positive rate quantified on a backtest dataset

---

## 🎯 v1.0 GA — "Production mainnet-blessed"

### Gate criteria

These must ALL be true before v1.0:

1. **≥ 20 wallets** real testnet-verified, ≥ 10 with mainnet readiness
2. **≥ 5 third-party-built connectors** (proves the certifier model works)
3. **SOC-2 Type II audit path** documented (or partner with a hosted offering that has it)
4. **Mainnet smoke test** — `pnpm smoke:e2e:mainnet` runs against real-funded wallets, lands real txs
5. **All language SDKs** at version parity (Python/TS/Go/Java/Rust)
6. **HKDR or 1+ regional stablecoin** integration ✅ (proves Asia coverage)
7. **At least 1 paying customer** OR a clear OSS adoption signal (≥ 1000 npm/pip downloads/week)
8. **"oap doctor" passes** in fresh clone with all wallets registered
9. **Production AWS deployment** running ≥ 30 days at ≥ 99.9% uptime
10. **Ops runbook + on-call escalation** documented

---

## 🚪 Decision gates we're watching

These external signals would shift the roadmap:

| Signal | If it happens | Roadmap impact |
|---|---|---|
| AWS opens up `CreatePaymentConnector` BYO API | New connector type registered upstream | Re-prioritize: ship our adapter as `day-1 reference impl`, market accordingly |
| Coinbase / Circle release native AP2 in their SDKs | AP2 becomes default mandate layer | Move v0.14 AP2-v0.2 work to v0.11 |
| HKDR mainnet launch with EIP-3009 | Asia coverage unlocked | New `wallet-hkdr-issuer` package, possibly a co-marketing post with HashKey |
| Stripe MPP v0.2 publishes | Stripe-side conformance | Protocol-mpp tests need re-spec'ing |
| OFAC adds new sanctioned address | Fast-path needed | Already handled by `OFACSdnAutoSyncChecker` 24h refresh — verify in production |

---

## 🎯 Long-term north star (v2.0+)

Beyond v1.0:

- **Universal AP2 mandate router** — work as the canonical implementation of AP2 across the entire crypto agent ecosystem
- **Verifiable Credentials over agent identity** (ERC-8004) — agents auto-bootstrap reputation
- **CDP-style "OpenAgentPay Cloud"** — managed offering for orgs that don't want self-host
- **Agent-to-agent payment marketplace** — agents discover services, pay, get paid; runs on top of OpenAgentPay's protocol matrix
- **Real-world asset (RWA) integration** — agents pay for tokenized invoices, real estate fractions, etc.

---

## 🔁 Roadmap feedback loop

Re-review this doc:
- After every release ship (update "Status" column)
- When a decision gate triggers (insert a section)
- Quarterly checkpoint (re-validate v1.0 gate criteria)

If the roadmap drifts from reality, **STATE.md should still be true** — that's the resumable state. The roadmap is aspirational; STATE.md is observational.

---

*Last updated: 2026-05-27 — post-v0.10.0 ship*
