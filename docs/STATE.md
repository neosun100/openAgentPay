# 📍 OpenAgentPay — Resume Here

> **This is the resumable state document.** If the laptop crashes, the chat session ends, or you come back in a month, **read this file first**. It will get you back to operational context in under 5 minutes.

---

## 🎯 Project mission (in one sentence)

> *LiteLLM let any LLM run with one line of code. **OpenAgentPay lets any AI agent pay with one line of code.***
>
> Goal: become the unifier ("CRI moment") for crypto agent payments — abstract over wallets, protocols, and agent frameworks so business code never changes when you switch any of them.

---

## 📊 Current state (post-v0.11.1 · last working session 2026-05-31)

```
Tests:        2045 passing     (TS 1993 + Python 52)   ← was 666 at v0.10 (3.07×)
Packages:     65                (was 40)
Protocols:    18 ProtocolAdapters  ← ALL 18 conformance-green (was 5)
Wallets:      28 WalletConnectors   ← 25 live in demo /api/wallets
L2 on-chain:  Stellar + Aptos funded via public faucets (pnpm l2:verify)
Frameworks:   10 plugins             (5 TS + 5 Python)
Layers:        L0 CLI · L1 Plugin · L2 Orchestration · L3 Protocol · L4 Wallet · L5 Settlement
Live URL:     https://d1p7yxa99nxaye.cloudfront.net  (AWS us-east-1)
CI:           .github/workflows/ci.yml (build + test + conformance + python)
```

**v0.11 shipped the wallet matrix**: 11 new connectors (Solana real-signer +
Stellar/Hedera/Sui/Aptos/TRON/Cosmos + Stripe-Privy/Circle/Magic/ZeroDev), each
conformance-green offline AND under `OPENAGENTPAY_LIVE_TESTS`. Every connector
generates a **real testnet keypair in-process** — no signups needed. Plus:
financial primitives productized (refund/subscription/receipt), HTTP auto-402
interceptor, GitHub Actions CI, and protocol-level conformance v2.

What's left is mostly the long-tail: funding the generated testnet keypairs to
land real on-chain txs (Lane A faucets), and Lane C ecosystem expansion.

---

## 🔥 If you're picking up tomorrow morning, do this

### Step 0 (30 seconds) — verify nothing rotted
```bash
cd ~/Code/openAgentPay
pnpm -r test 2>&1 | grep -E "Tests +[0-9]+ passed" | tail -50
# Expect: ~36 lines, all green
```

If anything red: `git status` + `git log --oneline -10` to see what changed.

### Step 1 (5 minutes) — read the docs in this order
1. **This file** (`docs/STATE.md`) ← you're here
2. **[`docs/TODO.md`](./TODO.md)** — current-sprint tasks with status + handoff notes
3. **[`docs/ROADMAP.md`](./ROADMAP.md)** — v0.11 → v1.0 quarterly plan
4. **[`docs/WALLET-SIGNUP-PLAN.md`](./WALLET-SIGNUP-PLAN.md)** — the 13 wallets you need to register for v0.11
5. **[`docs/POSITIONING.md`](./POSITIONING.md)** — strategic framing (LiteLLM-equivalent positioning, never goes stale)
6. **[`docs/COMPETITIVE-LANDSCAPE.md`](./COMPETITIVE-LANDSCAPE.md)** — Cobo/Skyfire/Stripe/Coinbase/Google AP2 comparison

### Step 2 (decide what to work on) — pick one of three lanes

**Lane A — finish v0.11 wallet integrations** (depends on you registering wallets)
- Read [`TODO.md`](./TODO.md) section "v0.11 Wallet Integrations"
- For each wallet you've already registered: post the credentials per the format in [`WALLET-SIGNUP-PLAN.md`](./WALLET-SIGNUP-PLAN.md), I implement the connector + run conformance.

**Lane B — polish without dependencies** (work I can do alone)
- See [`TODO.md`](./TODO.md) section "v0.11 Self-contained polish"
- Examples: demo-api yaml-bootstrap migration, GitHub Actions CI, more Python protocol bindings.

**Lane C — ecosystem expansion**
- See [`ROADMAP.md`](./ROADMAP.md) v0.12+ items
- Examples: refund/subscription productization, Java/Go SDK, OAP-CEX 2nd implementation, AP2 v0.2 A2A discovery.

---

## 🤝 What requires *you* (the human)

### Wallet credentials (Round 1 — Tier A self-serve, ~40 min total)

Register and paste credentials. Order: easiest first. **Full instructions in [`WALLET-SIGNUP-PLAN.md`](./WALLET-SIGNUP-PLAN.md).**

| # | Wallet | URL | Time | I get |
|---|---|---|---|---|
| A2 | Stellar Lab | https://laboratory.stellar.org/ | 2 min | `wallet-stellar` |
| A1 | Hedera Portal | https://portal.hedera.com/ | 5 min | `wallet-hedera` |
| A3 | Sui (Slush) | https://slush.app | 5 min | `wallet-sui` |
| A4 | Aptos (Petra) | https://petra.app | 5 min | `wallet-aptos` |
| A5 | TronLink Shasta | https://www.tronlink.org/ | 5 min | `wallet-tron` |
| A6 | Cosmos Theta (Keplr) | https://www.keplr.app | 8 min | `wallet-cosmos` |
| A7 | Solana Helius | https://www.helius.dev/ | 8 min | `wallet-solana` (real signer) |

**After Round 1**: every protocol has at least 1 real wallet behind it.

### Wallet credentials (Round 2 — Tier B email signups, ~60 min total)

| # | Wallet | URL | Time | I get |
|---|---|---|---|---|
| B1 | Voltage (Lightning) | https://voltage.cloud/ | 15 min | `wallet-lightning` (only L402 wallet) |
| B2 | Rafiki Open Payments | https://rafiki.money/ | 8 min | `wallet-open-payments` |
| B3 | Stripe Privy | https://dashboard.privy.io/ | 10 min | `wallet-stripe-privy` (closes AgentCore Path-D) |
| B4 | Circle PW | https://console.circle.com/ | 12 min | `wallet-circle-pw` |
| B5 | Magic.link | https://magic.link/ | 8 min | `wallet-magic` |
| B6 | ZeroDev | https://dashboard.zerodev.app/ | 8 min | `wallet-zerodev` |

### How to give me credentials

Easiest workflow:

1. Append to `.env.local.candidates` (already gitignored — `.env*` rule)
2. Tell me which wallet you've added
3. I implement, conformance-test, and provide a real testnet tx hash as proof

**Even 1-2 wallets at a time is fine.** Don't try to do all 13 at once.

---

## 🗂️ The persistent-memory file system

Everything that needs to survive a crash is in `docs/`. Strict invariants:

```
docs/
├── STATE.md                  ← you are here. Always start here.
├── ROADMAP.md                ← v0.11 → v1.0 quarterly plan
├── TODO.md                   ← current-sprint tasks (granular)
├── WALLET-SIGNUP-PLAN.md     ← Tier A/B/C wallet sign-up checklist
├── COMPETITIVE-LANDSCAPE.md  ← Cobo/Skyfire/Stripe/Google etc deep dive
├── POSITIONING.md            ← strategic framing (LiteLLM analog)
├── STRATEGY.md               ← original Asia/HashKey/Path-D strategy doc
├── GOVERNANCE.md             ← 7-Layer Guardrail deep dive
├── HASHKEY_DEMO.md           ← HashKey Chain demo reproduction guide
├── QUICKSTART.md             ← 5-minute setup
├── REFERENCES.md             ← AWS sample-repo vendoring notes
├── PRESENTATION.md           ← talk kit
└── TALK-CHEATSHEET.md        ← presentation cheatsheet

CHANGELOG.md                  ← version-by-version change log
README.md                     ← public face of project
```

**Invariant**: `STATE.md` (this file) only links to other docs — it does not duplicate their content. So if `TODO.md` is updated, `STATE.md` does not need a re-edit.

---

## 🧰 Codebase shape (so you / future-you can navigate)

```
~/Code/openAgentPay/
├── packages/
│   ├── core/                          # PaymentManager · Session · ProtocolRouter · WalletRouter · finance types
│   ├── governance/                    # 7-Layer Guardrail + Chainalysis + TRM + OFAC + ApprovalManager + PerAgent + Jurisdiction
│   ├── conformance/                   # 25-test suite for any third-party WalletConnector / ProtocolAdapter
│   ├── proxy/                         # LiteLLM-Proxy equivalent: multi-tenant + virtual API keys + bootstrapFromConfig
│   ├── cli/                           # `oap` CLI (config / doctor / conformance / version)
│   ├── config/                        # openagentpay.yaml schema (zod) + loader
│   │
│   ├── wallet-{hashkey,coinbase-cdp,binance,metamask,walletconnect,solana}/
│   │     # 6 wallet connectors today; conformance test suite enforces contract
│   │
│   ├── protocol-{x402,ap2,cex-pay,solana-pay,mpp,l402,stellar,w3c-payment,
│   │             sui,aptos,erc8004,skyfire,virtuals-acp,nevermined,
│   │             erc7777,tron-usdt,open-payments,hedera-hcs,cosmos-ibc}/
│   │     # 18 protocol adapters
│   │
│   ├── {langchain,llamaindex,mastra,vercel-ai,langgraph}-plugin/   # 5 TS plugins
│   ├── {strands,autogen,crewai,semantic-kernel,pydantic-ai}-plugin/ # 5 Python plugins
│   │
│   ├── python-sdk/                    # types-only Python mirror of core
│   └── cdk-deploy/                    # AWS CDK: API Gateway + Lambda + DynamoDB + Secrets Manager + CloudFront
│
├── apps/
│   ├── demo-api/                      # Express server (local) → Lambda (prod)
│   └── demo-web/                      # 5-tab Vite+React UI: Run / How / Agent / Guardrail / Spend Analytics
│
├── scripts/                           # smoke tests + Strands/LangChain demos + HashKey ref impl
└── docs/                              # see "persistent-memory file system" above
```

---

## 🔑 Critical facts to remember

1. **The 7 wallets that already work**: `hashkey-chain` (production), `coinbase-cdp` (production), `binance-pay` (sandbox), `metamask` (browser), `walletconnect` (mobile), `solana` (DemoSigner only — needs Helius upgrade).
2. **Conformance found a real bug** in `wallet-hashkey` v0.10 (silent accept of empty userId). This is the proof that the 25-test suite is real protection. Every new wallet **must** pass conformance before shipping.
3. **Path-D Hybrid is the strategic framing**: never positioned as "AgentCore Payments competitor" — always as "extension layer for non-CDP/non-Privy wallets."
4. **Network access from this Claude session is restricted** (WebFetch fails for `cobo.com` / `github.com` / etc). For research, prefer GitHub MCP if creds available, else use existing training data + WebSearch reasoning.
5. **Hook quirks**: Edit/Write tools sometimes report "Edit operation failed" via PostToolUse hook even when the file actually wrote successfully. Always verify with `cat` or a build command, not the hook message.
6. **All Lane B (self-contained polish) tasks can be picked up alone** — they don't depend on you registering wallets.

---

## 📞 Latest message from you (so I remember)

> 2026-05-27 — "把当前接下来的 to do list 都帮我存下来 我害怕就是整个服务中断了可就没了 你把这些 to do list 包括你当前这个开发进度 包括你建议我增加的这些东西 跟需要我给你配合的东西都留下来 都留到文档上来 都留到 roadmap 或者 to do list 里来 把它全部记录下来"
>
> Translation of intent: persist EVERYTHING (todos / current dev progress / what you suggest I add / what you need from me) so we can resume from any context loss.

This file (`STATE.md`) + `TODO.md` + `ROADMAP.md` + `WALLET-SIGNUP-PLAN.md` collectively satisfy that ask. They cross-link, do not duplicate, and each owns one specific responsibility.

---

*Last persisted: v0.10.0 final state · all 668 tests green · all packages built*
