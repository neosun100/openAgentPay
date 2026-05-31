# Changelog

All notable changes to **OpenAgentPay** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project does not yet follow strict semver — every commit on `main` is a
working snapshot.

---

## [0.11.1] · 2026-05-31 — **Breadth pass — 28 wallets · 18/18 protocols conformance-covered**

> **Headline**: a coverage-breadth expansion on top of v0.11.0. The wallet
> matrix goes **17 → 28 connectors** (added 6 new L1 chains + 3 institutional
> EVM wallets + 3 CEX), and **every one of the 18 protocol adapters now has a
> conformance suite** (was 5). Each new wallet generates a real testnet keypair
> in-process and passes all 25 conformance tests offline AND under
> `OPENAGENTPAY_LIVE_TESTS`.
>
> **Stats**: **1993 TS tests + 52 Python = 2045 passing** (was 666 at v0.10,
> 1294 at v0.11.0) · 18/18 protocols conformance-green · 28 wallet connectors ·
> zero failures.

### Added — 12 new wallet connectors (matrix 17 → 28)

New L1 chains (in-process real keypairs, conformance-green offline + LIVE):

| Wallet | Protocol | Crypto | Address |
|---|---|---|---|
| `wallet-near` | near-pay-v1 | Ed25519 | implicit 64-hex account |
| `wallet-algorand` | algorand-pay-v1 | Ed25519 + base32 checksum | 58-char uppercase |
| `wallet-cardano` | cardano-pay-v1 | Ed25519 + blake2b-224 + bech32 | `addr_test1…` |
| `wallet-ton` | ton-pay-v1 | Ed25519 + CRC16 + base64url | 48-char |
| `wallet-polkadot` | polkadot-pay-v1 | Ed25519 + SS58 + blake2b | SS58 base58 |
| `wallet-bitcoin` | bitcoin-pay-v1 | secp256k1 + segwit bech32 | `tb1q…` P2WPKH |

Institutional / embedded (EVM via viem, EIP-3009):

- `wallet-web3auth` (social-login MPC), `wallet-crossmint` (NFT-aware
  embedded), `wallet-fireblocks` (institutional MPC custody).

CEX (OAP-CEX HMAC, mirror wallet-binance):

- `wallet-okx`, `wallet-bitget`, `wallet-bybit`.

### Added — protocol conformance for the remaining 13 adapters (5 → 18/18)

`runProtocolConformance` wired into: aptos, cosmos-ibc, erc7777, erc8004,
hedera-hcs, nevermined, open-payments, skyfire, stellar, sui, tron-usdt,
virtuals-acp, w3c-payment. **Every Agent Payments protocol family now has a
contract guard.**

### Added — L2 real on-chain proof + CEX demo + UI truthing

- **`pnpm l2:verify`** (`scripts/l2-faucet-verify.ts`): uses each connector's
  in-process `generate*Keypair()` to mint a real address, hits the chain's
  public faucet (no signup), and confirms the account is live on-chain.
  Stellar testnet (Friendbot → 10000 XLM, Horizon-queryable) and Aptos devnet
  (faucet → CoinStore live) both confirmed L1→L2.
- **demo-api**: 3 CEX wallets (okx/bitget/bybit, OAP-CEX HMAC, auto mock
  credentials) registered → `/api/wallets` now serves **25 live wallets**.
- **demo-web**: Matrix header is now dynamic ("25 live wallets · 18
  protocols"); verified via Playwright that the capability bar renders all 25
  live chips and the Matrix grid (28 rows × 13 protocol columns) is correct.

### Fixed

- Conformance caught a real bug: `wallet-near` declared native NEAR at 24
  decimals, violating the WalletConnector contract's 18-decimal ceiling.
  Fixed to expose USDC (6dp) as the payment asset + surface native-NEAR's
  24dp via the `nativeNearDecimals` capability feature.

---

## [0.11.0] · 2026-05-31 — **Wallet matrix complete — "switch any chain with one line"**

> **Headline**: the v0.11 ship gate is met and exceeded. The wallet matrix goes
> from 6 → **17 connectors**, every one passing the 25-test conformance suite
> offline AND under `OPENAGENTPAY_LIVE_TESTS` (real sign + settle). Each new
> connector generates a **real testnet keypair in-process** — no signups, no
> credential-pasting — so the "switch `walletProvider`, same business code"
> claim becomes literally demonstrable across 8+ chains. Plus: financial
> primitives productized, an HTTP auto-402 interceptor, GitHub Actions CI, and
> protocol-level conformance v2.
>
> **Stats**: 53 packages · **1242 TS tests** + **52 Python tests** = **1294
> passing** (was 666) · 18 protocols · **17 wallets** · 10 agent frameworks ·
> 13 wallets live in the demo out of the box · zero failures.

### Added — 11 new wallet connectors (matrix 6 → 17)

Every connector is **cryptographically real** (verifiable signatures, correct
on-chain address format) yet runs fully offline; on-chain broadcast stays behind
a pluggable hook with an offline-safe default.

| Wallet | Protocol | Crypto | Address proof |
|---|---|---|---|
| `wallet-solana` (upgraded) | solana-pay-v1 | Ed25519 + base58 | real `solana-keygen` 64-byte secret |
| `wallet-stellar` | stellar-sep31-v1 | Ed25519 + StrKey (base32 + CRC16) | `G…` 56-char account |
| `wallet-hedera` | hedera-hcs-v1 | Ed25519 + DER | `0.0.x` account id |
| `wallet-sui` | sui-pay-v1 | Ed25519 + blake2b + bech32 | `0x…` + `suiprivkey1…` |
| `wallet-aptos` | aptos-pay-v1 | Ed25519 + sha3-256 | `0x…` 64-hex |
| `wallet-tron` | tron-usdt-v1 | secp256k1 + base58check | `T…` 34-char |
| `wallet-cosmos` | cosmos-ibc-v1 | secp256k1 + BIP39/BIP44 + bech32 | `cosmos1…` + 24-word mnemonic |
| `wallet-stripe-privy` | x402-v1 | secp256k1 (viem) EIP-3009 | closes AgentCore Path-D parity |
| `wallet-circle` | x402-v1 | secp256k1 (viem) + gas-station | USDC-native |
| `wallet-magic` | x402-v1 | secp256k1 (viem) email-bound | mainstream user wallet |
| `wallet-zerodev` | x402-v1 | ERC-4337 smart account | on-chain spending limits |

- The conformance suite caught a real latent bug in `SolanaConnector`
  (silent-accept of empty `userId`) — same class as the v0.10 hashkey bug.

### Added — financial primitives productized (`@openagentpay/core`)

- **`InMemorySubscriptionManager`** — BigInt credit ledger, idempotent
  `burnCredits`, `renew`/`cancel`/pause, expiry handling.
- **`PaymentManager.refund()`** — settled-payment ledger with
  `exceeds_original` / `already_refunded` / `original_not_found` /
  `not_supported` guards; `EchoRefundExecutor` test double.
- **Receipt issuance** — `issueReceipt` (uuid + total validation) +
  `signReceiptHmac` / `verifyReceiptHmac` (HMAC-SHA256 over canonical JSON).

### Added — `@openagentpay/http-interceptor`

- `wrapFetch` / `wrapAxios` — LiteLLM-style auto-402-retry (Coinbase
  `x402-axios` / `x402-fetch` equivalent). Dependency-light, duck-typed.

### Added — CI/CD + protocol conformance v2

- **`.github/workflows/ci.yml`** — TS build+test, wallet conformance
  (offline + LIVE), Python pytest (per-package isolated). README CI badge.
- **Protocol conformance v2** — `runProtocolConformance` wired into x402,
  MPP, L402, AP2, OAP-CEX (was wallet-level only). Pulls a v0.14 roadmap
  item forward.

### Changed — demo surfaces the full matrix

- **demo-api**: `buildSelfContainedBundles()` registers all 11 new
  connectors → `/api/wallets` returns **13 live wallets** out of the box.
- **demo-web**: new **Matrix** tab (wallets × protocols coverage grid) +
  Spend Analytics v2 (hand-rolled SVG sparkline + wallet-share bars);
  capability bar truthed to show live vs roadmap.

### Fixed

- `packages/pydantic-ai-plugin/README.md` was missing — its absence broke
  `uv sync --all-packages` (hatchling requires the referenced readme).
  Workspace sync now succeeds.

---

## [0.10.0] · 2026-05-24 — **The "Crypto-Agent-Payments LiteLLM" goal: ✅ achieved**

> **Headline**: OpenAgentPay reaches the "one-config-line to switch wallet"
> goal that defined the project. Adds `oap` CLI · `openagentpay.yaml` schema ·
> `WalletRouter` · finance primitives · Cobo PACT-style approval workflow ·
> Chainalysis/TRM/OFAC checkers · 5 new protocols · 3 new agent frameworks ·
> conformance-tested wallet-hashkey · yaml-driven proxy bootstrap · Spend
> Analytics dashboard.
>
> **Stats**: 40+ packages · 600+ TS tests passing · 54+ Python tests passing ·
> 13 protocols · 6 wallets · 10 agent frameworks · 7-Layer Guardrail
> production-ready · Conformance suite catches first real bug in wallet-hashkey
> ☑️.

### Added — `@openagentpay/cli` (`oap` binary)

- **`oap config init` / `validate` / `show`** — manage `openagentpay.yaml`
- **`oap doctor`** — full health check: yaml + secret resolution + tenant
  uniqueness + module reachability (15+ check points)
- **`oap conformance test --pkg <dir>`** — spawn vitest in any wallet/protocol
  package and emit a colored pass/fail report
- **`oap version`** + colored output + structured exit codes (0/2/3/4)
- 12 unit tests covering every subcommand + error path

### Added — `@openagentpay/config` (declarative yaml)

- Full `OpenAgentPayConfig` zod schema for wallets · protocols · governance ·
  routing · tenants
- 6-policy discriminated union (`amountThreshold` · `velocityLimit` ·
  `merchantWhitelist` · `merchantBlacklist` · `walletProviderWhitelist` ·
  `timeOfDay`)
- Secret URI grammar: `env://VAR` · `aws-secretsmanager://NAME` ·
  `file:///path` · `gcp-sm://NAME` · `inline://VALUE`
- Env-var overrides: `OAP_DEPLOYMENT_ENV` · `OAP_DEPLOYMENT_REGION` ·
  `OAP_ROUTING_STRATEGY`
- Full annotated `openagentpay.example.yaml` reference shipped
- 11 unit tests

### Added — `core/router/WalletRouter` (LiteLLM Router equivalent)

- Capability-aware wallet selection over a fleet of registered connectors
- 5 strategies: `priority` · `least-cost` · `least-latency` · `round-robin` ·
  `user-affinity`
- Automatic fallback on instrument-not-found
- `disabledProviders` kill switch + `maxAttempts` retry budget
- Returns full diagnostic `rejections[]` map for debuggability
- 14 unit tests

### Added — `core/finance/types` (production payment semantics)

- `Receipt` — merchant-attested record of a settled payment, with optional
  `MandateProof`-style signature
- `RefundRequest` / `RefundResult` / `RefundExecutor` — undo a settlement
- `Subscription` / `SubscriptionPlan` / `BurnCreditsInput` — prepaid credit
  ledger for nevermined-style services
- `IdempotencyEntry` / `IdempotencyStore` + `InMemoryIdempotencyStore` —
  defense against duplicate retries
- `FxQuote` / `FxOracle` + `StaticFxOracle` — multi-asset / multi-currency
  conversion with TTL'd quotes
- `PaymentSponsor` interface — decouples "who signs" from "who broadcasts"
  (Pimlico / Circle Gas Station pattern)
- 12 unit tests

### Added — `governance` v0.10 production extensions

- **`ChainalysisKYTChecker`** — wraps the Chainalysis KYT API, blocks at
  configurable risk levels, fail-closed by default. 4 tests.
- **`TRMLabsChecker`** — wraps TRM Labs Risk Score API, blocks at threshold.
  2 tests.
- **`OFACSdnAutoSyncChecker`** — auto-refresh OFAC SDN list from a feed URL,
  bloom-set in memory, supports both JSON and line-delimited formats. 4 tests.
- **`ApprovalManager`** (Cobo PACT-inspired) — multi-party approval state
  machine with `pending → approved → rejected → expired → executed` flow,
  N-of-M quorum, self-approval forbidden, idempotent re-approve, sweep job. 7 tests.
- **`PerAgentPolicyEngine`** — different agents get different policy bundles,
  with default fallback. 2 tests.
- **`jurisdictionRestriction()`** policy — block payments by initiator or
  recipient country, with `onUnknown: allow | deny`. 4 tests.
- All extensions ship as part of `@openagentpay/governance`, no new packages.

### Added — 5 new ProtocolAdapters

| Package | Protocol id | Use case |
|---|---|---|
| `@openagentpay/protocol-erc7777` | `erc7777-v1` | Human-Robot Society governance, identity registries + rule sets |
| `@openagentpay/protocol-tron-usdt` | `tron-usdt-v1` | TRON USDT (TRC-20), the highest-volume stablecoin on earth |
| `@openagentpay/protocol-open-payments` | `open-payments-v1` | Interledger Foundation's bank-grade open standard |
| `@openagentpay/protocol-hedera-hcs` | `hedera-hcs-v1` | Hedera HCS sub-cent fixed-fee micropayments |
| `@openagentpay/protocol-cosmos-ibc` | `cosmos-ibc-v1` | Cosmos zone cross-chain payments via IBC |

Each ships with full `detect` + `parsePaymentRequired` + `buildRetry` + 5–7
unit tests.

### Added — 3 new framework plugins

- `@openagentpay/vercel-ai-plugin` (TS) — Vercel AI SDK tool descriptor; 5 tests
- `@openagentpay/langgraph-plugin` (TS) — LangGraph node descriptor; 3 tests
- `openagentpay-pydantic-ai` (Python uv workspace) — PydanticAI tool factory
  with Pydantic v2 BaseModels for input/output; 8 tests

All three internally delegate to `OpenAgentPayLlamaTool` (in `llamaindex-plugin`)
as the framework-agnostic kernel — meaning **adding a new framework now takes
~50 lines of code and zero new payment logic**.

### Added — Cobo PACT competitive landscape research

- `docs/COMPETITIVE-LANDSCAPE.md` — 22 projects mapped to OpenAgentPay's 5-layer
  model (Coinbase x402 + AgentKit · Stripe MPP · Google AP2 · Skyfire · Circle
  Programmable Wallets · Cobo Agentic · Halliday · Pimlico · ZeroDev · Magic ·
  Crossmint · Web3Auth · Fireblocks · Anchorage · Nevermined · MetaMask ·
  WalletConnect · ERC-8004 · ERC-7777 · TRON · L402 · OpenPayments)
- 12 architectural patterns extracted as concrete `B*` action items
- `docs/WALLET-CANDIDATES.md` — 20 testnet wallets prioritized in 4 batches
  (Stripe Privy → Cobo → Circle → OKX → Lightning → Solana → Stellar → ...)

### Added — `@openagentpay/proxy` v0.10 yaml-driven bootstrap

- **`bootstrapFromConfig(cfg)`** — wires PaymentManager + Governance +
  TenantStore from an `OpenAgentPayConfig`. Wallets loaded via `import(decl.module)`
  with auto-detected factory shape (`createConnector` / `default`).
- **`oap-proxy start --config openagentpay.yaml`** — full yaml-driven server
  start. `oap-proxy demo` keeps the v0.9 zero-config path for local hacking.
- Failed wallet loads logged but non-fatal — proxy continues with the wallets
  that did load.
- Inline mintable API keys: `apiKey: inline://generate` mints a fresh
  `oap_sk_xxx` and prints it once on startup.
- 6 new bootstrap tests + 7 existing smoke tests = 13 proxy tests.

### Added — `apps/demo-web` Spend Analytics tab

- 5th UI tab: **Spend 📊** alongside Run / How / Agent / Guardrail
- KPI cards: total payments · total spend · deny rate · wallets used
- Per-wallet table with share %
- Per-actor table
- Recent settled transactions strip (last 30)
- Time-window selector: last 1h / 24h / 7d
- Auto-refreshes every 5s; backed by `GET /api/governance/audit?since=…`
- Exposes `audit-log source` (DynamoDB vs in-memory) inline for transparency

### Bug fix — `wallet-hashkey` `createInstrument({ userId: "" })`

- **Caught by the conformance suite** — first real bug found via the
  third-party-certifier flow.
- Previous behavior: silently created a junk Instrument with empty `userId`
- Fixed: throws `Error("createInstrument: userId is required")`
- All 25 conformance tests + 13 chain tests + 10 connector tests now pass
  (48 tests total in `wallet-hashkey`).
- Conformance test runs in two modes: gated (default — skips network) and
  live (`OPENAGENTPAY_LIVE_TESTS=true` — runs all 25).

### Test totals (this release)

```
@openagentpay/core              87 passed (was 75, +12 finance)
@openagentpay/conformance       25 passed
@openagentpay/governance        68 passed (was 45, +23 v0.10 extensions)
@openagentpay/proxy             13 passed (was 7, +6 bootstrap)
@openagentpay/cli               12 passed   ⭐ NEW
@openagentpay/config            11 passed   ⭐ NEW

@openagentpay/protocol-x402     22 passed
@openagentpay/protocol-ap2      29 passed
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/protocol-mpp       8 passed
@openagentpay/protocol-l402     21 passed
@openagentpay/protocol-stellar   8 passed
@openagentpay/protocol-w3c-payment 10 passed
@openagentpay/protocol-sui       9 passed
@openagentpay/protocol-aptos     8 passed
@openagentpay/protocol-erc8004  11 passed
@openagentpay/protocol-skyfire  14 passed
@openagentpay/protocol-virtuals-acp 9 passed
@openagentpay/protocol-nevermined 9 passed
@openagentpay/protocol-erc7777   7 passed   ⭐ NEW
@openagentpay/protocol-tron-usdt 5 passed   ⭐ NEW
@openagentpay/protocol-open-payments 6 passed ⭐ NEW
@openagentpay/protocol-hedera-hcs 5 passed   ⭐ NEW
@openagentpay/protocol-cosmos-ibc 5 passed   ⭐ NEW

@openagentpay/wallet-hashkey    48 passed (was 23, +25 conformance)
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
@openagentpay/wallet-metamask   11 passed
@openagentpay/wallet-walletconnect 7 passed
@openagentpay/wallet-solana     27 passed

@openagentpay/langchain-plugin  23 passed
@openagentpay/llamaindex-plugin 14 passed
@openagentpay/mastra-plugin      3 passed
@openagentpay/vercel-ai-plugin   5 passed   ⭐ NEW
@openagentpay/langgraph-plugin   3 passed   ⭐ NEW

demo-api                        22 passed
TypeScript subtotal            653 passed   (was 483, +170)

Python plugins:
  strands-plugin                23 passed
  autogen-plugin                 9 passed
  crewai-plugin                  7 passed
  semantic-kernel-plugin         7 passed
  python-sdk                     6 passed
  pydantic-ai-plugin             8 passed   ⭐ NEW
Python subtotal                 60 passed
─────────────────────────────────────
Grand total                    713 passed   (was ~530, +180)
```

### Architecture status (post v0.10.0)

```
┌──────────────────────────────────────────────────────────────────┐
│  L0 CLI                                                          │
│      oap (config / doctor / conformance / version)               │
│      oap-proxy (start --config / demo)                           │
│      openagentpay.yaml (declarative)                             │
├──────────────────────────────────────────────────────────────────┤
│  L1 Framework Plugins ×10                                        │
│      TS:     langchain · llamaindex · mastra · vercel-ai · langgraph │
│      Python: strands · autogen · crewai · semantic-kernel · pydantic-ai │
├──────────────────────────────────────────────────────────────────┤
│  L2 Orchestration                                                │
│      PaymentManager · ProtocolRouter · WalletRouter ⭐           │
│      SessionManager (InMemory + DynamoDB)                        │
│      Receipt · Refund · Subscription · Idempotency · FxOracle ⭐ │
│      7-Layer Guardrail (Policy + Compliance + Audit)             │
│        + Chainalysis · TRM · OFAC · Approval · PerAgent ⭐       │
├──────────────────────────────────────────────────────────────────┤
│  L3 ProtocolAdapter ×18                                          │
│      x402-v1/v2 · ap2 · cex-pay · solana-pay · mpp · l402        │
│      stellar · w3c-payment · sui · aptos · erc8004 · skyfire     │
│      virtuals-acp · nevermined                                   │
│      erc7777 ⭐ · tron-usdt ⭐ · open-payments ⭐ · hedera-hcs ⭐ │
│      · cosmos-ibc ⭐                                              │
├──────────────────────────────────────────────────────────────────┤
│  L4 WalletConnector ×6                                           │
│      hashkey · coinbase-cdp · binance · metamask · walletconnect │
│      · solana                                                    │
│      (each can be conformance-tested via `oap conformance test`) │
├──────────────────────────────────────────────────────────────────┤
│  L5 Settlement                                                   │
│      EVM RPC · CEX REST API · Solana RPC · IBC · Hedera Mirror   │
└──────────────────────────────────────────────────────────────────┘
```

### Migration notes

- No breaking API changes in `@openagentpay/core`, `@openagentpay/governance`,
  or any wallet/protocol package.
- `wallet-hashkey.createInstrument` now throws on empty `userId` — third-party
  callers passing an empty string will see `Error: createInstrument: userId is
  required`. Most callers were never doing this; the conformance suite caught
  it for completeness.
- `oap-proxy` CLI gained `start --config` and `demo` subcommands. The previous
  zero-arg invocation now maps to `start` (will read `./openagentpay.yaml`
  and exit 3 if missing — pass `demo` for the old behavior).

---

## [0.9.0] · 2026-05-24 — **Productize as "LiteLLM for Crypto Agent Payments"**

> **Headline**: OpenAgentPay reframes its strategic positioning to "Crypto Agent
> Payments' LiteLLM" and ships **two new packages** that close the productization
> gap with LiteLLM: a multi-tenant HTTP proxy server and a third-party connector
> conformance test suite.

### Added — `@openagentpay/proxy` (LiteLLM-Proxy equivalent)

- **`createProxy()`** — Express app factory mountable into any host
- **Virtual API key auth** — `Authorization: Bearer oap_sk_<24-hex>` or
  `X-OpenAgentPay-Key`. Keys are sha256-hashed at rest; plaintext shown once
- **Multi-tenant `Tenant` model** with per-tenant limits:
  - `allowedWallets[]` — wallet provider whitelist
  - `allowedProtocols[]` — protocol id whitelist
  - `dailyBudgetUsd` — hard cap enforced at session creation
  - `requireTwoPersonApprovalAboveUsd` — 2-person approval gate via
    `X-Second-Approver` header
  - `sandboxOnly` — forbid mainnet wallets
  - `status: active | suspended` — soft-disable kill switch
- **Endpoints**: `GET /v1/health`, `GET /v1/whoami`, `GET /v1/wallets`,
  `POST /v1/sessions`, `GET /v1/sessions/:id`, `POST /v1/instruments`,
  `POST /v1/payments`
- **Optional `governance.preCheck()` integration** — every payment runs
  Layer 3 + 5 + 7 of the Guardrail before signing
- **`InMemoryTenantStore`** for local dev + tests; DynamoDB store on roadmap
- **`oap-proxy` CLI binary** — `pnpm --filter @openagentpay/proxy start`
- 7 smoke tests pass (auth gating, tenant limits, suspended-tenant 403)

### Added — `@openagentpay/conformance` (third-party connector certification)

- **`runWalletConformance(runner, fixture, options)`** — 25 tests across
  7 categories (Capabilities · Instrument · Balance · Sign · Settle · Errors ·
  Determinism)
- **`runProtocolConformance(runner, fixture, options)`** — 13 tests across
  5 categories (Identity · detect · parse · buildRetry · Errors)
- **Framework-agnostic via injected `TestRunner`** — works with vitest, jest,
  mocha+chai, anything that exposes `describe/it/expect/beforeAll`
- **Network-gated tests skip cleanly** without `OPENAGENTPAY_LIVE_TESTS=true`
- **Self-test** — toy connector exercises all 25 tests, all green
- **Public surface**: `runWalletConformance`, `runProtocolConformance`,
  `WALLET_CONFORMANCE_GROUPS`, `CONFORMANCE_VERSION`, plus `TestRunner` /
  `WalletConformanceFixture` types

### Added — `docs/POSITIONING.md`

- Full strategic framing — OpenAgentPay as the LiteLLM-equivalent for
  crypto agent payments
- LiteLLM ↔ OpenAgentPay dimension-by-dimension comparison (17 axes)
- Three-wave roadmap (productization → high-ROI gaps → long-tail extension)
- Explicit non-goals (we won't build merchant infra / compete with AgentCore /
  do KYC implementation in-house / ship >2-3 connectors ourselves)

### Updated — `README.md`

- Tests badge bumped to **390 passing** (was 230)
- New badges: 6 wallets · 13 protocols · 7 plugins
- Hero section now opens with the LiteLLM one-liner positioning
- Project structure section reflects v0.8 + v0.9 reality (was stuck on v0.4
  with only 4 packages listed)

### Test totals

```
@openagentpay/core              61 passed
@openagentpay/governance        45 passed
@openagentpay/proxy              7 passed   ⭐ NEW
@openagentpay/conformance       25 passed   ⭐ NEW
@openagentpay/protocol-ap2      29 passed
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
@openagentpay/wallet-metamask   11 passed
@openagentpay/wallet-walletconnect 7 passed
@openagentpay/wallet-solana     27 passed
@openagentpay/langchain-plugin  23 passed
@openagentpay/llamaindex-plugin 14 passed
@openagentpay/mastra-plugin      3 passed
demo-api                        22 passed
TypeScript subtotal            346 passed   (was 306, +40 from proxy + conformance + minor)
Python plugins                  46 passed
─────────────────────────────────────
Grand total                    392 passed   (was 358, +34)
```

### Migration notes

- No breaking API changes in `@openagentpay/core` or any wallet/protocol package
- `@openagentpay/proxy` is opt-in — existing demo-api deployments continue to
  work unchanged
- Third parties writing new connectors are now expected to import
  `@openagentpay/conformance` into their tests

---

## [0.8.0] · 2026-05-21 — **Multi-Protocol Composition + Framework Plugin Matrix + Wallet Expansion**

> **Headline**: OpenAgentPay now compose-routes between 4 wire protocols
> (x402, OAP-CEX, AP2, Solana Pay), runs in 7 agent frameworks (LangChain,
> Strands, LlamaIndex, AutoGen, CrewAI, Semantic Kernel, Mastra), and ships
> 6 wallet connectors (HashKey, Coinbase CDP, Binance Pay, MetaMask,
> WalletConnect, Solana). 358 tests pass.

### Added — `@openagentpay/protocol-ap2` (Google AP2 mandate adapter)

- **Ap2ProtocolAdapter** — parses Intent/Cart/Payment Mandate envelopes
  (W3C Verifiable Credentials shape) carried alongside ANY settlement payload
- **MandateVerifier** pluggable interface (NullMandateVerifier default,
  production wires Ed25519/JWS/secp256k1)
- **verifyMandateChain()** — checks Intent→Cart→Payment linkage:
  * cart.intentMandateId matches intent.id
  * cart.totalAtomic ≤ intent.maxAmountAtomic
  * payment.cartMandateId matches cart.id
  * cart.merchant ∈ intent.allowedMerchants
  * expirationDate enforcement
- **buildIntentMandate / buildCartMandate / buildPaymentMandate** factories
- **Composition** with x402 / OAP-CEX / Solana Pay — AP2 is an authorization
  envelope, settlement protocols stay underneath
- 24-page SPEC.md explaining mandate model + composition pattern
- **29 unit tests pass**

### Added — `core/router/ProtocolRouter`

- Auto-dispatch over multiple ProtocolAdapter instances (first-match-wins)
- AP2 mandate envelope bridging — pulls `mandates[]` from 402 body and
  injects into `PaymentRequest.mandates`
- `byId()` / `list()` for diagnostics
- **16 unit tests pass**

### Added — `core/types.ts` Mandate primitives

- `Mandate` interface (W3C VC shape) + `MandateProof`
- `IntentMandateClaims`, `CartMandateClaims`, `PaymentMandateClaims`
- `PaymentRequest.mandates` optional field — flows through ANY connector

### Added — Layer 1 Framework Plugin matrix (5 new plugins)

| Plugin | Language | Tests |
|---|---|---|
| `@openagentpay/llamaindex-plugin` | TypeScript | 14 ⭐ NEW |
| `@openagentpay/mastra-plugin` | TypeScript | 3 ⭐ NEW |
| `openagentpay-autogen` | Python | 9 ⭐ NEW |
| `openagentpay-crewai` | Python | 7 ⭐ NEW |
| `openagentpay-semantic-kernel` | Python | 7 ⭐ NEW |

All five accept `mandates[]` parameter for AP2 composition.

### Added — `@openagentpay/wallet-metamask`

- **MetamaskConnector** — EIP-1193 provider-based, works with MetaMask /
  Rabby / Rainbow / Coinbase Wallet (extension)
- Browser-mode self-custodial signing via `eth_signTypedData_v4`
- Tx broadcast via `eth_sendTransaction`
- Pluggable `Eip1193Provider` interface (testable in pure-Node)
- **11 unit tests pass**

### Added — `@openagentpay/wallet-walletconnect`

- **WalletConnectConnector** — wraps WC v2 EthereumProvider, brings 200+
  mobile wallets (Trust, Rainbow mobile, OKX Wallet mobile, ImToken,
  BitKeep, etc.) under the same WalletConnector interface
- Lazy `connect()` triggers QR / deep-link pairing
- Decorates instruments with `peerWalletName` for UI
- **7 unit tests pass**

### Added — `@openagentpay/wallet-solana` (non-EVM proof)

- **SolanaPayProtocolAdapter** — parses `solana:` URLs per official spec
  (https://docs.solanapay.com/spec)
  * Supports USDC mainnet / devnet, native SOL, arbitrary SPL tokens
  * Extracts amount / recipient / spl-token / reference / message / memo
- **SolanaConnector** — Ed25519 signer abstraction, single-shot model
  (signAuthorization+settle collapse to single tx submit)
- **DemoSolanaSigner** for tests — production wires @solana/web3.js
- **27 unit tests pass**

### 5-Layer architecture status (post v0.8.0)

| Layer | Components | Status |
|---|---|---|
| **L1 Framework Plugin** | langchain · llamaindex · mastra · strands · autogen · crewai · semantic-kernel | ✅ × 7 |
| L2 PaymentManager | core (InMemory + DynamoDB) | ✅ |
| L3 ProtocolAdapter | x402-v1 · cex-pay-v0.1 · ap2-v0.1 · solana-pay-v1 + ProtocolRouter | ✅ × 4 + router |
| L4 WalletConnector | hashkey · coinbase-cdp · binance · metamask · walletconnect · solana | ✅ × 6 |
| L5 Settlement | EVM RPC · CEX API · Solana RPC | ✅ |

### Test totals

```
@openagentpay/core              61 passed (was 45, +16 ProtocolRouter)
@openagentpay/protocol-ap2      29 passed   ⭐ NEW
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/governance        45 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
@openagentpay/wallet-metamask   11 passed   ⭐ NEW
@openagentpay/wallet-walletconnect 7 passed ⭐ NEW
@openagentpay/wallet-solana     27 passed   ⭐ NEW
@openagentpay/langchain-plugin  23 passed
@openagentpay/llamaindex-plugin 14 passed   ⭐ NEW
@openagentpay/mastra-plugin     3 passed    ⭐ NEW
demo-api                        22 passed
TypeScript subtotal            306 passed (was 207)
Python (strands-plugin)         23 passed
Python (autogen-plugin)         9 passed    ⭐ NEW
Python (crewai-plugin)          7 passed    ⭐ NEW
Python (semantic-kernel-plugin) 7 passed    ⭐ NEW
Python (python-sdk)             6 passed
─────────────────────────────────────
Grand total                    358 passed   (was 230, +128)
```

## [0.7.0] · 2026-05-20 — **Layer 2 Persistence: DynamoDB SessionManager**

> **Headline**: Sessions now persist to DynamoDB. Solves the "Session not found"
> bug from v0.4.2 where Lambda warm-instance affinity caused subsequent calls
> to a different instance to lose access to the session.

### Added — `@openagentpay/core` DynamoDBSessionManager

- New `DynamoDBSessionManager` class implementing `SessionManager`
- Optimistic concurrency: read-then-conditional-update with version field
- Auto-retry on `ConditionalCheckFailedException` (default 3 attempts)
- Strong-consistent reads (`ConsistentRead: true`)
- TTL-based auto-eviction (24h after expiry)
- Pluggable command factories — same pattern as DynamoDBAuditSink
- 24 new unit tests (45 total in core package)

### Added — CDK infrastructure

- New table `openagentpay-sessions`:
  - PK: id (S) — single-table design, no GSIs needed
  - On-demand billing
  - Point-in-time recovery enabled
  - TTL on `ttlEpoch` attribute
- Lambda IAM auto-grant: `grantReadWriteData(apiFn)`
- Env var `SESSIONS_TABLE_NAME` set automatically

### Added — demo-api integration

- `apps/demo-api/src/context.ts` lazy-loads DynamoDBSessionManager when
  `SESSIONS_TABLE_NAME` env var present (Lambda mode)
- Falls back to InMemorySessionManager locally
- Graceful degradation: SDK init failure → log + InMemory fallback

### Bug fixed

Multi-Lambda warm instance session loss:

```
Before v0.7.0:
  POST /api/session            → Lambda A creates session in memory
  POST /api/pay (hashkey)      → Lambda A handles, finds session ✅
  POST /api/pay (coinbase-cdp) → Lambda B (different warm) → 404 ❌

After v0.7.0:
  All Lambda instances read/write the same DynamoDB session ✅
```

Verified: a single session ID handled 3 payments across 2 wallets:
- hashkey-chain  tx 0x5f016f7dba1e07ee...
- coinbase-cdp   tx 0x5ce737e8acf26799...
- hashkey-chain  tx 0xc6b622b56bbd95ed...

Final state: spentAtomic=3000, version=6 (3 reserves + 3 commits).

### scripts/smoke-e2e.ts simplified

Steps 6 + 7 now use the SAME session created in step 5. Previously workaround
code created fresh sessions per payment.

### 7-Layer Guardrail persistence status (post v0.7.0)

| Layer | Component | Persisted |
|---|---|---|
| L2 **Session** | core/DynamoDBSessionManager | ✅ **NEW v0.7.0** |
| L3 Policy | governance/PolicyEngine | ✅ stateless |
| L4 On-chain | EIP-3009 | ✅ on-chain |
| L5 Compliance | governance/ComplianceChecker | ✅ stateless |
| L6 Identity | AWS Secrets Manager + KMS | ✅ |
| L7 Audit | governance/DynamoDBAuditSink (v0.6.0) | ✅ |

### Test results

```
@openagentpay/core              45 passed (was 21, +24 dynamodb-session)
@openagentpay/governance        45 passed
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
@openagentpay/langchain-plugin  23 passed
demo-api                        22 passed
TypeScript subtotal            207 passed
Python (strands-plugin)         23 passed
─────────────────────────────────────
Grand total                    230 passed
```

E2E smoke (12 steps) against production: 12/12 ✅


## [0.6.0] · 2026-05-20 — **Layer 7 Persistence: DynamoDB AuditSink**

> **Headline**: Audit log now persists to DynamoDB in production. Every
> governance decision (policy_check, compliance_check, payment_success/failure)
> survives Lambda cold starts. Queryable by actor, by kind, or by timestamp range.

### Added — `@openagentpay/governance` DynamoDBAuditSink

- New `DynamoDBAuditSink` class implementing `AuditSink`
  - Append-only PutItem with conditional non-existence check
  - Pluggable command factories (real SDK in production, mocks in tests)
  - 22 new unit tests (45 total in governance package)
- Three query methods:
  - `queryByActor()` — partition-key query, optional time-range filter
  - `queryByKind()` — uses byKind GSI (e.g., all policy_denied events)
  - `getByEventId()` — single-event lookup via byEventId GSI
- All complex fields (policyEvaluations, complianceCheck, metadata)
  JSON-serialized for clean DynamoDB storage; deserialized on read
- Tolerant of malformed JSON in stored fields (no exceptions)
- @aws-sdk peer dependency (optional) — package works without it for non-DynamoDB users

### Added — CDK infrastructure

- New DynamoDB table `openagentpay-audit-log`
  - PK: actor (S), SK: timestampEventId (S)
  - GSI byKind (kind, timestamp), GSI byEventId (eventId)
  - On-demand billing, point-in-time recovery, optional TTL
- Lambda IAM auto-grant: `grantReadWriteData(apiFn)`
- Env var `AUDIT_TABLE_NAME` set automatically by CDK

### Added — demo-api integration

- `apps/demo-api/src/context.ts` lazily creates DynamoDBAuditSink when
  `AUDIT_TABLE_NAME` env var present (Lambda mode)
- Composite sink: writes to BOTH DynamoDB (durable) + InMemory (hot path)
  for fast `/api/governance` reads without DynamoDB read costs
- Audit emit failures are logged but never fail the request (graceful degradation)
- New endpoint `GET /api/governance/audit`
  - `?actor=...` → DynamoDB primary key query
  - `?kind=...` → DynamoDB byKind GSI query
  - `?since=ISO8601&limit=N&cursor=...` → time range + pagination
  - Falls back to in-memory buffer when no actor/kind specified
  - Response includes `source: 'dynamodb' | 'in-memory'` for transparency
- 4 new integration tests (22 total in demo-api package)

### Production verification (live)

```
$ pnpm smoke:e2e:prod
🎉 All e2e smoke tests passed!

$ aws dynamodb scan --table-name openagentpay-audit-log
9 events persisted
  - policy_check     allowed/denied
  - compliance_check allowed/denied
  - payment_success  with real tx hashes (HashKey + Base Sepolia)

$ curl 'https://d1p7yxa99nxaye.cloudfront.net/api/governance/audit?actor=demo-user'
source=dynamodb, events=3   ✅

$ curl 'https://d1p7yxa99nxaye.cloudfront.net/api/governance/audit?kind=payment_success'
source=dynamodb, events=2 with real tx hashes   ✅
```

### 7-Layer Guardrail status (post v0.6.0)

| # | Layer | Implementation | Persisted |
|---|---|---|---|
| 2 | Session | core/SessionManager (in-memory) | ❌ planned |
| 3 | Policy | governance/PolicyEngine | ✅ stateless |
| 5 | Compliance | governance/ComplianceChecker | ✅ stateless |
| 7 | **Audit** | governance/DynamoDBAuditSink | ✅ **NEW** persistent |

### Test results

```
@openagentpay/core              21 passed
@openagentpay/governance        45 passed (was 23, +22 dynamodb-sink)
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
@openagentpay/langchain-plugin  23 passed
demo-api                        22 passed (was 18, +4 audit query)
TypeScript subtotal            183 passed
Python (strands-plugin)         23 passed
─────────────────────────────────────
Grand total                    206 passed
```

E2E smoke (12 steps) against production: 12/12 ✅


## [0.5.1] · 2026-05-19 — **Layer 1: Strands Plugin (Python)**

> **Headline**: Second Layer 1 framework adapter — `openagentpay-strands` —
> lets AWS Strands Agents (Python) make payments via OpenAgentPay's HTTP API.
> Strands SDK is an OPTIONAL dependency: the package works as a plain async
> function without it, and decorates with @tool when Strands is installed.

### Added — `openagentpay-strands` Python package (`packages/strands-plugin/`)

- `OpenAgentPayClient` — async HTTP client for the demo-api
  - `pay()` with auto session lifecycle (lazy create + 404 recovery)
  - `list_wallets()`, `get_governance()` for inspection
  - Per-instance session affinity counter for tests
  - 30s timeout default, 5s session expiry buffer
- `create_payment_tool()` factory
  - Returns async callable; if Strands SDK installed, also decorates with @tool
  - Custom `name` parameter for multi-tool agents
  - Errors converted to JSON for LLM (never raises to caller)
- `PaymentResult` dataclass with `to_dict()` LLM-friendly output
- `OpenAgentPayError` with structured `code` + `http_status`
- 23 pytest tests covering:
  - PaymentResult/Error shapes
  - HTTP client list_wallets / get_governance / pay
  - Session lazy creation + 404 recovery
  - Governance deny path returns PaymentResult (not exception)
  - 5xx HTTP raises
  - Validation errors (negative amount, empty fields)
  - Tool factory + JSON output
  - Tool error handling (HTTP / validation / governance all → JSON)

### Added — `scripts/strands-demo.py`

- Live demo against production CloudFront with 3 scenarios:
  1. Coinbase CDP payment → real Base Sepolia tx
  2. HashKey Chain payment → real HashKey tx
  3. Over-budget (00) → policy_denied
- Verified tx (this release):
  - Base Sepolia: [`0xa26f99b8…`](https://sepolia.basescan.org/tx/0xa26f99b8a64577e5254510ff56d777596da38e218f69186598a65592edda15e0)
  - HashKey: [`0x229995d9…`](https://testnet-explorer.hsk.xyz/tx/0x229995d90ce7e7b1198d0a8709919fc82cbbd5c95d0f0c8ab8a927eae3b8df71)

### Test totals

```
TypeScript: 157 passed
Python:      23 passed (strands-plugin)
─────────────────────────────────────
Grand total: 180 passed
```

E2E smoke (12 steps) against production: 12/12 ✅

### 5-Layer Architecture (post v0.5.1)

| Layer | Components | Status |
|---|---|---|
| **L1 Framework Plugin** | langchain-plugin (TS) · **strands-plugin (Py)** | ✅ × 2 |
| L2 PaymentManager | core | ✅ |
| L3 ProtocolAdapter | protocol-cex-pay | ✅ |
| L4 WalletConnector | wallet-{hashkey, coinbase-cdp, binance} | ✅ |
| L5 Settlement | chain RPC + CEX API | ✅ |


## [0.5.0] · 2026-05-19 — **Layer 1: LangChain Plugin**

> **Headline**: OpenAgentPay now ships **Layer 1 framework integration** — the
> 5-layer architecture is complete. Any LangChain agent (OpenAI Functions /
> Anthropic / Bedrock / etc.) can autonomously make payments by calling
> a single `StructuredTool`.

### Added — `@openagentpay/langchain-plugin` package

- **OpenAgentPayTool** extending `@langchain/core` `StructuredTool`
  - Returns JSON string back to LLM (parseable, structured)
  - Built-in zod schema (amountUsd, recipient, reason, walletProvider?)
  - Description tells LLM exactly when and how to use it
- **createPaymentTool(cfg)** factory — preferred public API
- Lazy session creation + auto-renewal on expiry
- Optional governance integration — preCheck before signing, audit after
- Pluggable hooks: `resolveProtocolForWallet`, `toMoney`, `toAsset`,
  `generateNonce`, `now` (for tests), `recentPayments` buffer
- 23 unit tests covering metadata, schema validation, happy path,
  governance deny paths, session lifecycle, _call (LangChain invocation),
  error handling, recentPayments buffer

### Added — Live demo script

- `scripts/langchain-demo.ts` — exercises full plugin against HashKey Chain
  Testnet with 3 scenarios:
  1. Allowed payment → real on-chain tx
  2. Over-budget payment → policy_denied
  3. Sanctioned recipient → compliance denied
- All 6 audit events recorded as expected
- Demo-verified tx: [`0xf94385c2…`](https://testnet-explorer.hsk.xyz/tx/0xf94385c2d7f8cf6ba1e0122693ac9875e103988ad4aa51ce57a1ed30fe6e97bb)

### 5-Layer architecture status (post v0.5.0)

| Layer | Component | Status |
|---|---|---|
| **L1 Framework Plugin** | `@openagentpay/langchain-plugin` | ✅ NEW v0.5.0 |
| L2 PaymentManager | `@openagentpay/core` | ✅ |
| L3 ProtocolAdapter | `@openagentpay/protocol-cex-pay` | ✅ |
| L4 WalletConnector | wallet-hashkey, wallet-coinbase-cdp, wallet-binance | ✅ |
| L5 Settlement | chain RPC, CEX API | ✅ |

### Test results

```
@openagentpay/core              21 passed
@openagentpay/governance        23 passed
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
@openagentpay/langchain-plugin  23 passed   ← NEW
demo-api                        18 passed
─────────────────────────────────────────
Total                          157 passed
```

E2E smoke (12 steps) against production: 12/12 ✅

## [0.4.2] · 2026-05-19 — **Test Coverage Hardening**

Pre-Layer-1-extension hardening release. Locks in current behavior with
comprehensive test coverage before adding the LangChain plugin.

### Added

- **demo-api integration tests** (18 new tests, total 134 across monorepo)
  - `tests/fixtures/mock-context.ts`: mock connectors that record every call
  - `tests/integration.test.ts`: 7 describe blocks
- **scripts/smoke-e2e.ts**: automated e2e against any deployment URL
  - `pnpm smoke:e2e` (local) / `pnpm smoke:e2e:prod` (CloudFront)
  - 12-step pipeline including real on-chain payments
- New test API: `__setContextForTest()` for context injection

### Fixed

- **Real production bug**: `RECENT[]` payment cache was a module-level
  mutable array, leaking state across tests AND across Lambda warm
  invocations. Moved to `ctx.recentPayments`. Verified deployed to production.

## [0.4.1] · 2026-05-19 — **Guardrail Dashboard Tab + Architecture Diagram**

Patch release surfacing the 7-Layer Guardrail across UI, docs, and an
SVG architecture diagram.

### Added

- **demo-web 4th tab** (`GuardrailTab.tsx`): 7-layer stack visualization,
  Try-It buttons, real-time audit log auto-refreshing every 3s
- **SVG architecture diagram** (`svg/guardrail-7-layers.svg`): vertical
  600x920 layout. Hosted on CDN.
- **`docs/GOVERNANCE.md`** (380 lines): per-layer deep dive with code
  examples and AgentCore Payments comparison


## [0.4.0] · 2026-05-19 — **Governance: 7-Layer Guardrail**

> **Headline**: OpenAgentPay now ships **Layer 3 (Policy) + Layer 5 (Compliance) +
> Layer 7 (Audit)** of the AgentCore Payments-style 7-layer Guardrail. Every payment
> goes through a configurable spending policy chain, sanctions check, and append-only
> audit log — all enforced before signing or settlement.

### Added — `@openagentpay/governance` package

- **PolicyEngine** with composable rules:
  - `velocityLimit({ windowMs, maxCount, maxAmountAtomic })` — sliding-window rate limits
  - `amountThreshold({ maxAtomic })` — single-payment hard cap
  - `merchantWhitelist(addresses)` / `merchantBlacklist(addresses)` — allow/block lists
  - `walletProviderWhitelist(providers)` — restrict wallets per agent
  - `timeOfDay({ startHourUtc, endHourUtc })` — only allow during business hours
- **ComplianceChecker** for sanctions / OFAC / illicit finance:
  - `StaticSanctionsChecker` — in-memory list with multiple sources
  - `CompositeComplianceChecker` — fail-closed aggregator (extension point for Chainalysis / TRM Labs / Elliptic)
- **AuditLogger** with append-only structured events:
  - `InMemoryAuditSink` (capacity-bounded circular buffer for demo)
  - `ConsoleAuditSink` (single-line JSON for grep/jq parsing)
  - Future production sinks: S3 / CloudWatch / OpenSearch / Splunk
- **GovernanceManager** facade — single `preCheck()` call runs Policy + Compliance + Audit
- 23 unit tests covering all policies, compliance composition, audit retention

### Added — Demo API integration

- `apps/demo-api/src/context.ts` builds a default `GovernanceManager` with:
  - $50 single-payment cap (`amountThreshold`)
  - 20 payments per minute velocity limit
  - $100 hourly spend cap velocity limit
  - Demo sanctions list (Tornado Cash router + Lazarus Group illustrative addresses)
- `POST /api/pay` runs `governance.preCheck()` BEFORE signing — denies surface as
  `success: false, errorCode: 'policy_denied'` with structured reason
- Successful and failed payments record `recordSuccess` / `recordFailure` audit events
- **`GET /api/governance`** new endpoint — lists active policies, compliance status,
  last 50 audit events. UI can subscribe / refresh to show audit trail in real time.
- Recent payments tracked in-memory for velocity policy lookback

### Test results — `pnpm -r test`

```
@openagentpay/core              21 passed
@openagentpay/governance        23 passed   ← NEW
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
─────────────────────────────────────────
Total                          116 passed   (was 93)
```

### 7-Layer Guardrail status (post v0.4.0)

| # | Layer | OpenAgentPay implementation | Status |
|---|---|---|---|
| 1 | Authorization | Out of scope (upstream auth) | — |
| 2 | Session | `@openagentpay/core` SessionManager (budget + TTL) | ✅ |
| 3 | **Policy** | `@openagentpay/governance` PolicyEngine | ✅ NEW |
| 4 | On-chain | EIP-3009 transferWithAuthorization | ✅ |
| 5 | **Compliance** | `@openagentpay/governance` ComplianceChecker | ✅ NEW |
| 6 | Identity | AWS Secrets Manager + KMS | ✅ |
| 7 | **Audit** | `@openagentpay/governance` AuditLogger | ✅ NEW |

---

---

## [0.3.0] · 2026-05-19 — **Path D Hybrid: Multi-Wallet, Multi-Chain**

> **Headline**: OpenAgentPay now ships with **two production-grade wallet
> connectors** running side-by-side in the same demo. Switch wallets with a
> single click; same `PaymentManager`, same `Session`, same business code.

### Added — Coinbase CDP wallet connector ([`packages/wallet-coinbase-cdp/`](./packages/wallet-coinbase-cdp/))

- **CoinbaseCDPConnector** implementing `WalletConnector` against
  [Coinbase CDP V2 SDK](https://docs.cdp.coinbase.com/) (managed wallets, TEE-secured keys)
- Targets **Base Sepolia testnet** (chainId 84532) with **Circle's official
  USDC contract** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — production-grade,
  not mock
- Full EIP-3009 `transferWithAuthorization` flow:
  - `signAuthorization()` → CDP `account.signTypedData()` (private key never leaves CDP TEE)
  - `settle()` → CDP `account.sendTransaction()` broadcasts on-chain
- Conformance tests: 11 unit tests covering capabilities, instrument lifecycle, nonce generation
- E2E smoke script `scripts/coinbase-cdp-smoke.ts` — verified on-chain
  (tx [`0xb8f4f86a…`](https://sepolia.basescan.org/tx/0xb8f4f86ac5cb16d46f18507d12e4baa962e78077de93eb4d40f3bf4259fb9e37))

### Added — Demo API path D hybrid

- **`apps/demo-api/src/context.ts`**: `connectors: Map<provider, ConnectorBundle>`
  loads HashKey + Coinbase CDP side-by-side
- **`GET /api/wallets`**: lists all available wallet providers with chain/token metadata
- **All endpoints** now accept optional `walletProvider` parameter (query string
  on `GET /api/wallet`, body field on `POST /api/pay`) — routing by UI dropdown
- Lambda integration: secrets loaded from Secrets Manager via ARN
  (`COINBASE_CDP_API_KEY_SECRET_ARN`, `COINBASE_CDP_WALLET_SECRET_ARN`)

### Added — Demo Web UI redesign

- **Capability Bar** replaces old static "HashKey Chain Testnet" badge:
  - **LIVE section**: chips for every available wallet (active glows green,
    others click to switch). Replaces the old dropdown.
  - **ROADMAP section**: 22 planned wallets across 5 categories
    (EVM self-custodial · managed · non-EVM chains · CEX · traditional payment)
    with category-colored left border accents
  - `+∞` chip emphasizes "any wallet matching the `WalletConnector` interface plugs in"
- **Tab status pill**: tabs row shows current chain + token (`Base Sepolia · USDC (Circle official)`)
- **Banner tagline** changed from `Live · HashKey Chain Testnet` to
  permanent `Open · Pluggable · Agent Payments`
- HTML `<title>` updated to `OpenAgentPay · Open Agent Payments`
- Sidebar dynamically renders chain/token labels and architecture flow per
  selected wallet (no more hardcoded HashKey values)

### Added — CDK infrastructure

- `DemoStackProps` extended with optional `coinbaseCdp*` fields
- Two new Secrets Manager secrets created when CDP credentials present:
  - `CoinbaseCdpApiKeySecret` (KMS-encrypted)
  - `CoinbaseCdpWalletSecret` (KMS-encrypted, PKCS#8 PEM)
- Lambda IAM policy automatically grants read on both new secrets
- Deployment is **opt-in**: if CDP env vars not set, stack still deploys with
  HashKey only (backward compatible)

### Verified on production CloudFront

| # | Path | Tx | Chain |
|---|---|---|---|
| 1 | `scripts/coinbase-cdp-smoke.ts` (local) | [`0xb8f4f86a…`](https://sepolia.basescan.org/tx/0xb8f4f86ac5cb16d46f18507d12e4baa962e78077de93eb4d40f3bf4259fb9e37) | Base Sepolia |
| 2 | localhost:8787 demo-api | [`0x0ef38063…`](https://sepolia.basescan.org/tx/0x0ef380636fb722c4b3ca0d9247cdbdfd4caed45018eb7bf77afa2ec3b3024463) | Base Sepolia |
| 3 | localhost:8787 demo-api (HashKey switch) | [`0x6bc45964…`](https://testnet-explorer.hsk.xyz/tx/0x6bc45964a249c8cfc8ba651fec05ee66e2b39915b9c1e400fbda78b6ac5b8b12) | HashKey Chain |
| 4 | **Production CloudFront → Lambda** | [`0xb6e6674f…`](https://sepolia.basescan.org/tx/0xb6e6674ffe5c269e7664d4a8a776ab95077ab0d46b03ed980909c7ff1d91db97) | Base Sepolia |

### Changed

- `apps/demo-api/src/handlers.ts` rewritten: every handler accepts optional
  `walletProvider`, falls back to `ctx.defaultProvider` for backward compat
- `apps/demo-web/src/api.ts`: `wallet()`, `pay()` accept optional
  `walletProvider` argument
- `Sidebar.tsx`: dropdown now driven by `/api/wallets` response, dynamically
  renders explorer links per chain (Basescan vs Blockscout)

### Test results — `pnpm -r test`

```
@openagentpay/core              21 passed
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed   ← NEW
@openagentpay/wallet-binance    20 passed
─────────────────────────────────────────
Total                           93 passed   (0 failed)
```

---

## [0.2.0] · 2026-05-17 — **Live on AWS**

- AWS deployment: API Gateway HTTP API + Lambda + CloudFront + S3 + Secrets Manager (KMS)
- Live URL: https://d1p7yxa99nxaye.cloudfront.net
- AWS Lambda → HashKey Chain Testnet verified (tx [`0xd18cb0f1…`](https://testnet-explorer.hsk.xyz/tx/0xd18cb0f19359bdaae17aa89a0e14c47ccb7793579b9a09ac0423eefb1390a06a))
- 23-page presentation deck + 18,928-word talk notes
- 13 architecture diagrams (10 SVG + 3 generated)

---

## [0.1.0] · 2026-05-17 — **MVP**

- Project scaffold + Apache 2.0 license
- `WalletConnector` and `ProtocolAdapter` interfaces in `@openagentpay/core`
- `@openagentpay/wallet-binance` — Binance Pay (OAP-CEX path, sandbox-locked)
- `@openagentpay/protocol-cex-pay` — OAP-CEX v0.1 spec + adapter (24-page IETF-style draft)
- `@openagentpay/wallet-hashkey` — HashKey Chain Connector (TypeScript)
  - MockUSDC + EIP-3009 deployed to HashKey Chain Testnet
  - Python reference implementation in `scripts/hashkey/transfer-with-auth.py`
  - Both Python and TypeScript implementations produce identical on-chain effects
- `@openagentpay/core` — `InMemoryPaymentManager` + `InMemorySessionManager`
- Express API + Vite React three-tab UI
- 4 on-chain transactions verifying end-to-end flow

---

*Maintainer: [Neo Sun](https://github.com/neosun100). Issues and PRs welcome.*
