# 📋 OpenAgentPay — Active TODO List

> **Always-up-to-date sprint tasks.** If you finish anything, mark it ✅. If you discover a new task, add it under the right lane.
>
> See [`STATE.md`](./STATE.md) for the resumable-state entry point.
> See [`ROADMAP.md`](./ROADMAP.md) for the quarterly arc.

---

## 🎯 Future Backlog — recorded for later execution (2026-06-01)

> Snapshot of all **positive-value directions** worth doing next, captured at the
> end of the v0.16→v0.20 session (61 wallets · 22 protocols · 35 frameworks · 6
> SDKs · 4114 tests · world-class README + brand logo all shipped to main).
> Grouped by **what they need from Neo**. Nothing here is started — this is the
> "pick up later" list.

### 🅰️ Needs Neo's credentials (highest ROI — mirror the OKX live-proof model)

Each: register → paste into `.env.local` → I write smoke + live-verify → promote
to **L2-confirmed** in demo-web → CHANGELOG → PR → merge. (Magic/ZeroDev/OKX
already done = 3/7 of "A-class".)

| # | Wallet | Why it matters | Signup | Effort |
|---|---|---|---|---|
| F-A1 | **Circle Programmable Wallets** | USDC-native, strong compliance posture | console.circle.com (self-serve) | ~12 min |
| F-A2 | **Bybit** (testnet) | 2nd-tier CEX, validates OAP-CEX breadth | testnet.bybit.com | ~10 min |
| F-A3 | **Bitget** | Asian CEX coverage | bitget.com → API Mgmt | ~10 min |
| F-A4 | **Crossmint** | Managed wallet + NFT/commerce angle | crossmint.com/console (Staging) | ~8 min |
| F-A5 | **Stripe Privy** | closes AgentCore Path-D parity | dashboard.privy.io (⚠ HK网络登录报错，换手机热点) | ~10 min |
| F-A6 | **HashKey Pro sandbox** | OAP-CEX 3rd impl, Asia compliance | global.hashkey.com | 🔴 KYC + sales |
| F-A7 | **Cobo Agentic Wallet** ⭐ | competitor-named "very important" — AI-agent MPC + approval workflow; direct strategic positioning | cobo.com sandbox | 🔴 KYC + sales |
| F-A8 | **Fireblocks** (real sandbox) | bank-grade MPC; connector exists (mock) → promote to L2 | fireblocks.com | 🔴 KYC + sales |
| F-A9 | **BitGo / Anchorage** | institutional custody, top-tier compliance | sales contact | 🔴 institutional |

### 🅱️ Self-contained (no credentials — I can execute alone anytime)

| # | Item | Why it matters | Effort |
|---|---|---|---|
| F-B1 | **Turnkey / Dfns / Safe / Lit Protocol** connectors | new-gen API-first agent-wallet infra; self-serve dashboards, no KYC to start | ~15 min each |
| F-B2 | **`oap proxy` cluster mode** | DynamoDB-backed TenantStore + shared session/audit for multi-tenant SaaS | ~8 hr |
| F-B3 | **Spend Analytics: ML anomaly detection** | z-score baseline → detect compromised agents by spend deviation | ~10 hr |
| F-B4 | **More protocol adapters** | h402 · PayTo · Bolt12 · (watch new IETF/W3C drafts) | ~3 hr each |
| F-B5 | **`docs/MIGRATION-FROM-LITELLM.md`** | cognitive bridge for LiteLLM users (the audience we target) | ~2 hr |
| F-B6 | **demo-web polish** | L2-badge visual emphasis · live cert cards from a real `/api/certify` endpoint · A2A discovery tab | ~4 hr |
| F-B7 | **`@openagentpay/http-interceptor` for more clients** | LiteLLM-style auto-402-retry for more HTTP libs (got/ky/superagent) | ~3 hr |
| F-B8 | **Conformance v3 published spec doc** | write the wallet/protocol contract as a versioned, citable spec for `oapconformance.io` | ~4 hr |

### 🌍 International promotion (needs Neo to execute; copy is ready in `docs/PITCH.md`)

| # | Item | Notes |
|---|---|---|
| F-P1 | **Show HN launch** | title/copy ready in `docs/PITCH.md`; pick a Tue–Thu morning ET |
| F-P2 | **X/Twitter + Product Hunt** | tweet + paragraph ready in `docs/PITCH.md` |
| F-P3 | **GitHub topics + About** | apply the topics list from `docs/PITCH.md` |
| F-P4 | **Submit to awesome-lists** | awesome-ai-agents / awesome-web3 / agent-payments roundups |
| F-P5 | **Conference / talk** | `docs/PRESENTATION.md` + `docs/TALK-CHEATSHEET.md` exist; refresh to v0.20 |

### ⭐ My top-3 recommendation when we resume

1. **F-A1 Circle + F-A7 Cobo** — Circle is fast/self-serve and USDC-native (strongest narrative); Cobo is the strategic competitor-parity play. Together they cover "USDC-native compliance" + "AI-agent MPC".
2. **F-B6 demo-web polish** — make the live demo visually match the now-world-class README (zero credentials, high perceived value).
3. **F-P1 Show HN** — the README/logo/pitch are launch-ready; the marginal value of *shipping awareness* now exceeds another connector.

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
- **Status**: ✅ done (v0.17) — `oap pay/session` + `parseAmount`; 27 tests

### B4 — Python SDK: full client (not just types)
- **Status**: ✅ done — `packages/python-sdk/openagentpay/client.py` is a full
  396-line async `OpenAgentPayClient` (create_session / pay / get_session /
  list_wallets / get_governance / get_audit / pay_once) + 419 lines of tests.
  Mirrors the TS HTTP contract (client→proxy model).

### B5 — More framework plugins (Python)
- **Status**: ✅ done (v0.17) — +bedrock-agentcore +instructor (7 Python total); ongoing → F-B1
- Possible future candidates: `dspy`, more as frameworks emerge

### B6 — Refund / Subscription productization
- **Status**: ✅ done (v0.11) — `PaymentManager.refund()` + settled-payment
  ledger guards; `InMemorySubscriptionManager` BigInt credit ledger; `Receipt`
  issuance + HMAC sign/verify. 39+ new core tests.

### B7 — `@openagentpay/http-interceptor` (LiteLLM-style auto-402-retry axios/fetch)
- **Status**: ✅ done (v0.11) — `wrapFetch` / `wrapAxios`, dependency-light,
  duck-typed. 14 tests.

### B8 — S3 WORM AuditSink
- **Status**: ✅ done (v0.17) — `S3WormAuditSink` Object-Lock COMPLIANCE (2555d default), 15 offline tests

### B9 — `oap audit` CLI subcommand
- **Status**: ✅ done (v0.17) — `oap audit --since/--kind/--actor/--result/--json`, 13 tests

### B10 — Spend Analytics Tab v2 — charts
- **Status**: ✅ done — `apps/demo-web/src/SpendAnalyticsTab.tsx` has hand-rolled
  inline SVG charts ("Cumulative spend" + wallet share), no chart library.

---

## Lane C — Ecosystem expansion (longer-term, I'd pick these last)

### C1 — Java SDK (`com.openagentpay.sdk`)
- **Status**: ✅ done — `sdks/java` HTTP client **+ in-process engine** (v0.18), 30 tests
- **Why**: Spring AI / LangChain4j users — large enterprise market

### C2 — Go SDK (`github.com/openagentpay/sdk-go`)
- **Status**: 🔒 backlog
- **Why**: Cloud / infrastructure programs use Go
- **Status**: ✅ done — `sdks/go` HTTP client **+ in-process engine** (v0.18), 56 tests

### C3 — Rust SDK
- **Status**: ✅ done — `sdks/rust` async reqwest client (v0.15), 18 tests

### C4 — OAP-CEX 2nd implementation (validates protocol, not just Binance-shape)
- **Status**: ✅ done (v0.18.1) — **OKX** live Demo-Trading sandbox proof (`pnpm smoke:okx`, OK-ACCESS-SIGN accepted by real API). 3rd impl (HashKey Pro) → F-A6 backlog.

### C5 — AP2 v0.2 A2A discovery
- **Status**: ✅ done — `protocol-a2a-discovery` (v0.15) + `Ap2V2Negotiator` (v0.18)
- **Why**: Cross-agent payment with capability discovery — google's roadmap item

### C6 — Cobo Agentic Wallet integration
- **Status**: 🔒 deferred → see **F-A7** (review-required at Cobo; top strategic pick)
- **Effort**: ~6 hr after credentials

### C7 — Stripe MPP v2 (when published)
- **Status**: 🔒 backlog — `protocol-mpp` v0.1 shipped; watch IETF draft for v2

### C8 — Federated Conformance — third-party-ran tests
- **Status**: 🟡 partially done — `@openagentpay/certifier` + reusable `certify.yml` (v0.16/v0.18) ship the engine; public `oapconformance.io` dashboard → F-B8 backlog.

### C9 — Spend Analytics: anomaly detection (ML)
- **Status**: 🔒 backlog → see **F-B3** (z-score baseline)
- **Why**: Detect compromised agents by spend pattern deviation

### C10 — `oap proxy` cluster mode
- **Status**: 🔒 backlog → see **F-B2**
- **Why**: For high-throughput multi-tenant SaaS — DynamoDB-backed TenantStore, shared session/audit state

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
[████████████████████] 61 wallets · 35 frameworks · 6-lang SDKs · 22 protocols (+ACP/WebMon/GNAP)    ✅ v0.19.0

v1.0 readiness (subjective):
[██████████████████░░] 90%
   - Core abstractions: 100%
   - Wallet coverage:   90%   ← was the biggest gap, now closed
   - Protocol coverage: 95%   (+ protocol conformance v2)
   - Plugin coverage:   88%
   - Productization:    98%   (refund/subscription/receipt/interceptor/oap-pay/S3-WORM)
   - Compliance/gov:    80%
   - CI/CD:             100%  (was 0%)
```

---

*Last updated: 2026-06-01 — post-v0.20 (61 wallets/8 L2 · 22 protocols · 35 frameworks · 6 SDKs · 4114 tests · world-class README + brand logo shipped). Future Backlog recorded (F-A/F-B/F-P) for next session.*
*Update protocol: when a task moves status, update the row + bump the "Last updated" line.*
