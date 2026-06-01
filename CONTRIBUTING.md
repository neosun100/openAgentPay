# Contributing to OpenAgentPay

Thanks for helping build the open control plane for AI agent payments. This guide covers the three most common contributions — a **wallet connector**, a **protocol adapter**, and a **framework plugin** — plus the build/test workflow and PR conventions.

---

## Prerequisites

- **Node ≥ 22.13**, **pnpm ≥ 11** (the monorepo uses Node 22's `node:sqlite`).
- For Python plugins: [`uv`](https://docs.astral.sh/uv/).
- Go / Java / Rust toolchains only if you touch `sdks/{go,java,rust}`.

```bash
git clone https://github.com/neosun100/openAgentPay && cd openAgentPay
pnpm install
pnpm -r build && pnpm -r test    # everything should be green before you start
```

Per-package:

```bash
pnpm --filter @openagentpay/<pkg> build
pnpm --filter @openagentpay/<pkg> test
# Python plugin:
cd packages/<name>-plugin && uv run --no-project --with . --with pytest python -m pytest tests/ -q
```

---

## Add a wallet connector

1. Copy `packages/wallet-hashkey` (the most fully-tested template). For non-EVM chains, `packages/wallet-stacks` (hand-rolled keygen) is a good reference; for EVM, `packages/wallet-sonic`.
2. Implement the 5-method `WalletConnector` interface from `packages/core/src/types.ts`:
   - `getCapabilities()` — pure.
   - `createInstrument(input)` — throw on empty `userId`; must be idempotent.
   - `getBalance(instrumentId)` — throw on unknown id.
   - `signAuthorization(input)` — throw on wrong protocol / unknown id; produce a **real verifiable signature**.
   - `settle(signed)` — broadcast behind a pluggable, offline-safe `submit` hook.
3. Generate a **real in-process keypair** (`@noble/curves`, `@scure/*`) — no external signups required for L1.
4. **Required**: add `tests/conformance.test.ts` using `@openagentpay/conformance/wallet` and pass all **25 tests** — offline AND under `OPENAGENTPAY_LIVE_TESTS=true`.

```bash
oap conformance test --pkg packages/wallet-your-wallet
```

5. Money is always `{ amountAtomic: string, decimals: number, currency: string }` — never a float. Asset decimals must be ≤ 24.
6. Add a CHANGELOG entry and surface the wallet in the demo-web Matrix tab.

## Add a protocol adapter

1. Copy `packages/protocol-mpp` (lightweight template).
2. Implement `ProtocolAdapter`: `detect` / `parsePaymentRequired` / `buildRetry` / optional `preSubmit`. Throw `ProtocolError` on malformed input.
3. **Required**: `tests/conformance.test.ts` via `@openagentpay/conformance/protocol` (13 tests) + ≥ 6 unit tests.

## Add a framework plugin

1. TS: mirror `packages/mastra-plugin` — a thin shim over `OpenAgentPayLlamaTool` (the kernel in `@openagentpay/llamaindex-plugin`).
2. Python: mirror `packages/strands-plugin` — async client + tool factory + Pydantic-typed result. **Always include a `README.md`** (a missing one breaks `uv sync`).
3. **Never reimplement payment logic** — delegate to the kernel. ≥ 4 tests covering descriptor shape + delegation + `walletProvider` override.

---

## PR conventions

- **Conventional Commits**: `feat(wallet): …`, `fix(core): …`, `docs(readme): …`.
- One logical change per commit; run `git diff --staged` before committing.
- **Never stage build artifacts** — `dist/`, `target/`, `node_modules/`, `__pycache__/` are gitignored; double-check `git status` before `git add`.
- **Never commit secrets** — `.env*` is gitignored; nothing matching `sk-` / `ghp_` / `oap_sk_` should appear.
- All CI checks must pass (build · test · conformance · Python · Go · Java · Rust). CI runs on clean runners, so things that pass locally can still fail — fix forward.

## Good first contributions

- A new **wallet connector** for a chain we don't cover yet (copy the template, pass conformance).
- A new **framework plugin** for an agent framework you use (≈ 70-line shim).
- Promote an existing **L1 connector to L2** by wiring a real testnet RPC / sandbox credential and adding a smoke script (see `scripts/okx-smoke.ts`, `scripts/l2-evm-smoke.ts`).

By contributing you agree your work is licensed under Apache-2.0.
