# OpenAgentPay — Project Instructions for Claude Code

> **Auto-loaded by Claude Code at every session start.** This file is the project's "savepoint" — when a new chat session begins, this gets injected into Claude's context, ensuring continuity across sessions, machines, and time.

---

## 🚨 FIRST ACTION when you start a new session

**Always read `docs/STATE.md` immediately before doing anything else.** It contains the resumable state — what we've built, what's next, what needs the human (Neo).

```bash
# Equivalent to "load savepoint":
cat docs/STATE.md
```

After STATE.md, glance at:
- `docs/TODO.md` — current sprint tasks with status
- `docs/ROADMAP.md` — quarterly arc through v1.0
- `docs/WALLET-SIGNUP-PLAN.md` — wallet sign-up checklist (Neo's action items)

---

## 🎯 Project mission

OpenAgentPay = **"LiteLLM for Crypto Agent Payments."** Unified abstraction over wallets × protocols × agent frameworks. Switch any of them with one config-line change; business code never changes.

**Strategic stance**: AgentCore Path-D Hybrid — never positioned as competitor to AWS Bedrock AgentCore Payments. Always positioned as the extension layer for non-CDP/non-Privy wallets.

---

## 🏗️ Architecture (5 + 1 layers)

```
L0 CLI       — `oap` (config/doctor/conformance) + `oap-proxy` (yaml-driven)
L1 Plugin    — 10 frameworks (langchain/llamaindex/mastra/vercel-ai/langgraph + 5 Python)
L2 Orchestration — PaymentManager + ProtocolRouter + WalletRouter + finance + Guardrail
L3 Protocol  — 18 ProtocolAdapters
L4 Wallet    — 28 WalletConnectors (v0.11.1 ✅; 22 live in demo)
L5 Settlement — chain RPC / CEX REST / Solana RPC / IBC / Hedera Mirror
```

---

## 📊 Current state (snapshot — re-verify with `pnpm -r test`)

```
Tests: 2045 passing (TS 1993 + Python 52)
Packages: 65
Wallets: 28 connectors (22 live in demo)
Protocols: 18 adapters (all 18 conformance-green)
Latest version: v0.11.1 (shipped 2026-05-31)
Live URL: https://d1p7yxa99nxaye.cloudfront.net
CI: .github/workflows/ci.yml
```

Always trust `docs/STATE.md` over this snapshot — `STATE.md` is updated more frequently than `CLAUDE.md`.

---

## 🔧 Workflow conventions (don't deviate)

### Build / test / lint
```bash
pnpm install                      # workspace install
pnpm -r build                     # build all TS packages
pnpm -r test                      # test all TS packages
pnpm --filter <pkg-name> test     # test one package

# Python plugins
cd packages/<plugin-name>
uv run --no-project --with pytest python -m pytest tests/ -q
```

### Adding a new wallet
1. Use `packages/wallet-hashkey` as the most fully-tested template
2. Create `packages/wallet-<name>/` with `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{index,connector}.ts`, `tests/`
3. **MUST** add a conformance test: `tests/conformance.test.ts` using `@openagentpay/conformance/wallet`
4. **MUST** pass all 25 conformance tests + connector unit tests before shipping
5. Add `wallet-<name>` entry to demo-web's capability bar
6. Add a CHANGELOG entry with a real testnet tx hash as proof

### Adding a new protocol
1. Use `packages/protocol-mpp` as the lightweight template
2. Implement `ProtocolAdapter` interface (4 methods: detect / parsePaymentRequired / buildRetry / preSubmit?)
3. Tests live in `tests/adapter.test.ts`; aim for ≥ 5 unit tests covering detect / parse / buildRetry / errors
4. Add to `apps/demo-api`'s ProtocolRouter so the live demo can route it

### Adding a new framework plugin
- For TS: mirror `packages/mastra-plugin` — it's a 70-line wrapper over `@openagentpay/llamaindex-plugin`'s `OpenAgentPayLlamaTool` (the framework-agnostic kernel)
- For Python: mirror `packages/strands-plugin` — async client + tool factory + Pydantic-typed result
- **Don't reinvent payment logic**. Always delegate to the kernel.

### Hook quirks (real bugs you'll hit)
- **PostToolUse hook sometimes reports "Edit operation failed" even when Edit succeeded.** Always verify with `cat` or a build command, not the hook message.
- **`pnpm install` won't see fresh `package.json` changes** unless you run `pnpm install --no-frozen-lockfile`. The "Already up to date" message is misleading.
- **Edit fails with "File has not been read yet"** if you didn't `Read` the file first in the current session. Use `Write` for fresh files; `Edit` only for previously-read ones.

---

## 🧠 Decision conventions (so future-Claude makes consistent calls)

### Conformance is non-negotiable
Every new wallet/protocol **must** pass the conformance suite (25 tests for wallets, 13 for protocols). The suite caught a real bug in `wallet-hashkey` v0.10 — that's its proof of value. Don't ship without it.

### Tests > docstrings
When in doubt about how something works, **write a unit test**. The repo has 668 tests for a reason — they're the real spec.

### Keep the kernel framework-agnostic
`OpenAgentPayLlamaTool` (in `@openagentpay/llamaindex-plugin`) is the universal payment-tool kernel. Every framework plugin (vercel-ai, mastra, langgraph, etc) is a thin shim over it. **If you're adding payment logic to a plugin, stop — move it into the kernel instead.**

### Path-D Hybrid framing
Never write "OpenAgentPay replaces AgentCore." Always "OpenAgentPay extends AgentCore." See `docs/POSITIONING.md` for the exact talking points.

### Atomic units everywhere
Money is `{ amountAtomic: string, decimals: number, currency: string }` — never `number`. Float drift in payments is a real bug surface; we structurally prevent it.

---

## 🔑 Critical files (don't move/rename without warning)

```
packages/core/src/types.ts                   ← canonical interfaces; if you change this, EVERYTHING ripples
packages/core/src/router/{protocol-router,wallet-router}.ts ← LiteLLM-Router-equivalents
packages/conformance/src/wallet.ts           ← 25-test contract
packages/governance/src/manager.ts           ← preCheck() flow (Layer 3+5+7)
packages/proxy/src/configBootstrap.ts        ← yaml→runtime entry point
packages/cli/src/cli.ts                      ← `oap` CLI dispatcher
packages/config/src/schema.ts                ← openagentpay.yaml zod schema

apps/demo-api/src/context.ts                 ← still has hardcoded wallet wiring (TODO B1: migrate to bootstrapFromConfig)
apps/demo-web/src/App.tsx                    ← 5-tab UI

scripts/hashkey/transfer-with-auth.py        ← Python ref impl of EIP-3009 — kept for cross-language proof
```

---

## 📨 Communication style with Neo (the human maintainer)

- **Language**: Chinese-primary (mandarin), with English code/docs. Neo (Neo Sun, GMT+8, Hong Kong/Shanghai) prefers concise direct technical communication.
- **No filler phrases**: don't say "I understand" / "I'll help you with that" / "Let me know if..." Just do it.
- **Show, don't tell**: when reporting results, lead with the empirical fact (test count, build status, tx hash) before the narrative.
- **Code-first answers**: prefer concrete file paths, command examples, and diff snippets over prose explanations.
- **Insight format**: when there's a non-obvious insight worth surfacing, wrap in a `★ Insight ─────────...` box. See existing chat for examples.

---

## 🎁 What Neo asks me to do (recurring patterns)

- "推进/继续" → execute the in-progress TODO items from `docs/TODO.md` Lane B (self-contained, no human needed)
- "你看缺什么" → re-run gap analysis vs `docs/COMPETITIVE-LANDSCAPE.md` and add to `TODO.md`
- "全力以赴" → don't ask for permissions, just ship until the build is green
- "保存上下文" → update `docs/STATE.md` + `docs/TODO.md` to reflect current reality (this CLAUDE.md is the entry; STATE.md is the snapshot)

---

## 🚦 What's next at any given moment

The answer is in `docs/TODO.md`. There's always:
- A **Lane A** track (depends on Neo registering wallets)
- A **Lane B** track (I can do alone — pick from the top)
- A **Lane C** track (longer-term, lower priority)

If unsure, default to **Lane B's top item** that has the highest impact for least effort. Today (post-v0.10) that's:
1. B1: Migrate `apps/demo-api` to `bootstrapFromConfig` (~2 hr, removes the last hardcoded wallet wiring)
2. B2: GitHub Actions CI (~3 hr, gates every future PR)

---

## 📜 License & ownership

- License: Apache-2.0
- Maintainer: Neo Sun (`@neosun100`)
- Repo: https://github.com/neosun100/openAgentPay
- Live: https://d1p7yxa99nxaye.cloudfront.net (AWS us-east-1)

---

## 🛡️ Safety

- **Never commit secrets**. `.env.local*` is gitignored. Anything matching `sk-` / `ghp_` / `oap_sk_` should never appear in a commit.
- **Testnet only** until v1.0 GA. Don't write code that talks to mainnet wallets/contracts unless `OPENAGENTPAY_LIVE_TESTS=true` AND the user has explicitly opted in.
- **Conformance + integration tests must pass** before any merge to main.

---

*Last updated: 2026-05-29 — established as project savepoint per Neo's request.*
*Update protocol: when project conventions or critical-file paths change, edit this file. Day-to-day state lives in `docs/STATE.md`.*
