<div align="center">

<img src="./svg/logo-wordmark.svg" alt="OpenAgentPay" width="540" />

### The open control plane for AI agent payments

**Any wallet. Any protocol. Any agent framework. In one line of code.**

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/neosun100/openAgentPay/actions/workflows/ci.yml/badge.svg)](https://github.com/neosun100/openAgentPay/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-4114_passing-brightgreen)](#-quality--proof)
[![Live on AWS](https://img.shields.io/badge/demo-live_on_AWS-FF9900)](https://d1p7yxa99nxaye.cloudfront.net)

[![Wallets](https://img.shields.io/badge/wallets-61_connectors-a18cd1)](#-wallet-coverage-61-connectors)
[![Protocols](https://img.shields.io/badge/protocols-22_adapters-c084fc)](#-protocol-coverage-22-adapters)
[![Frameworks](https://img.shields.io/badge/agent_frameworks-35_plugins-e89bd6)](#-agent-framework-coverage-35-plugins)
[![SDKs](https://img.shields.io/badge/SDKs-6_languages-fbc2eb)](#-sdks-6-languages)

[**🚀 Live Demo**](https://d1p7yxa99nxaye.cloudfront.net) · [**⚡ Quickstart**](#-quickstart) · [**📊 Coverage**](#-coverage-at-a-glance) · [**🏗️ Architecture**](#️-architecture) · [**🤝 Contributing**](./CONTRIBUTING.md)

</div>

---

> **LiteLLM let any LLM run with one line of code.**
> **OpenAgentPay lets any AI agent _pay_ with one line of code.**

OpenAgentPay is an open, pluggable abstraction layer over **wallets × payment protocols × agent frameworks**. Swap any of the three with a one-line config change — your business logic never changes. It is the unifying control plane for the emerging *Crypto Agent Payments* space, the way LiteLLM became the unifier for LLM inference.

```ts
// Same business code. Switch the rail by changing one field.
await pay({ walletProvider: "coinbase-cdp", amount: "1.50 USDC", to: merchant }); // x402 on Base
await pay({ walletProvider: "okx",          amount: "1.50 USDC", to: merchant }); // OAP-CEX on OKX
await pay({ walletProvider: "stellar",      amount: "1.50 USDC", to: merchant }); // Stellar SEP-31
```

📖 Full strategic framing → [`docs/POSITIONING.md`](./docs/POSITIONING.md) · Resume any session → [`docs/STATE.md`](./docs/STATE.md)

---

## 📊 Coverage at a glance

<div align="center">

| Layer | What it abstracts | Count |
|:--|:--|:--:|
| **L0 · CLI** | `oap` (config · doctor · conformance · pay · session · audit) · `oap-proxy` · `certifier-cli` | ✅ |
| **L1 · Agent Framework Plugins** | LangChain · LlamaIndex · Vercel AI · Mastra · CrewAI · AutoGen · Strands · … | **35** |
| **L2 · Orchestration** | PaymentManager · ProtocolRouter · WalletRouter · 7-Layer Guardrail · refund/subscription/receipt | ✅ |
| **L3 · Protocol Adapters** | x402 · AP2 · OAP-CEX · ACP · Web Monetization · GNAP · MPP · L402 · … | **22** |
| **L4 · Wallet Connectors** | EVM · CEX · MPC/smart-account · Move · Cosmos · Bitcoin/UTXO · … (8 L2-confirmed) | **61** |
| **L5 · Settlement** | EVM RPC · CEX REST · Solana RPC · IBC · Hedera Mirror | ✅ |
| **SDKs** | TypeScript · Python · Go · Java · Rust (+ in-process engines) | **6 langs** |

**4,114 tests** passing across 5 languages · **0 failures** · CI-gated · [live on AWS](https://d1p7yxa99nxaye.cloudfront.net)

</div>

---

## ⚡ Quickstart

```bash
git clone https://github.com/neosun100/openAgentPay && cd openAgentPay
pnpm install           # Node ≥ 22.13, pnpm ≥ 11
pnpm demo              # → API on :8787  +  Web UI on http://localhost:5173
```

Then open the **7-tab control panel**: `Run` · `How It Works` · `AI Agent` · `Guardrail` · `Spend Analytics` · `Wallet Matrix` · `Certify`.

Run the test suite or a live proof:

```bash
pnpm -r test           # 3,921 TS tests (+ Python/Go/Java/Rust in their dirs)
pnpm smoke:okx         # real OKX Demo Trading sandbox — OAP-CEX signature accepted live
pnpm smoke:l2evm       # Magic + ZeroDev addresses queryable on live Base Sepolia
pnpm l2:verify         # Stellar + Aptos + Sui funded on-chain via public faucets (3/3)
```

---

## 💳 Wallet coverage (61 connectors)

> 8 are **L2-confirmed** ✅ — verified against a real chain or exchange (not just signature-real). The rest are L1 conformance-green (real in-process keypair + real signature; broadcast pluggable). Every connector passes the **25-test conformance suite**.

**EVM & L2** — `arbitrum` · `base` · `blast` · `linea` · `mantle` · `mode` · `optimism` · `polygon` · `scroll` · `zksync` · `berachain` · `berachain-mainnet` · `ronin` · `sonic` · `metamask` · `walletconnect`

**Managed · MPC · Smart-account** — `coinbase-cdp` · `circle` · `fireblocks` · `magic` ✅ · `zerodev` ✅ · `web3auth` · `crossmint` · `stripe-privy`

**CEX (OAP-CEX)** — `binance` · `okx` ✅ · `bitget` · `bybit` · `hashkey`

**Non-EVM chains** — `solana` · `aptos` ✅ · `sui` ✅ · `movement` · `near` · `near-mainnet` · `cosmos` · `celestia` · `initia` · `injective` · `sei` · `stellar` ✅ · `hedera` · `tron` · `tron-mainnet` · `ton` · `ton-mainnet` · `polkadot` · `cardano` · `flow` · `tezos` · `ripple` · `aleo` · `starknet` · `fuel` · `stacks` · `algorand` · `hashkey` (`hashkey-chain` ✅)

**Bitcoin & UTXO** — `bitcoin` · `litecoin` · `dogecoin` · `monero` · `kaspa`

---

## 🔌 Protocol coverage (22 adapters)

> Every adapter passes the **13-test protocol conformance suite** + composition v3. One `ProtocolAdapter` interface (`detect` / `parsePaymentRequired` / `buildRetry` / `preSubmit`) spans six standards ecosystems.

| Ecosystem | Adapters |
|:--|:--|
| **Coinbase** | `x402` (v1/v2 HTTP-402 micropayments) |
| **Google** | `ap2` (mandate envelope, W3C VC) · `a2a-discovery` (AP2 v0.2 agent-to-agent) |
| **OpenAI / Stripe** | `acp` (Agentic Commerce) · `mpp` (Merchant Payments Protocol) |
| **W3C** | `web-monetization` (Interledger) · `w3c-payment` (Payment Request + SPC) |
| **IETF** | `gnap` (RFC 9635 grant negotiation) |
| **Lightning** | `l402` (LSAT) |
| **CEX** | `cex-pay` — **OAP-CEX v0.1** (Binance + OKX live-verified) |
| **Chain-native** | `stellar` · `sui` · `aptos` · `cosmos-ibc` · `hedera-hcs` · `tron-usdt` · `open-payments` |
| **Agent identity / registry** | `erc8004` · `erc7777` · `skyfire` · `virtuals-acp` · `nevermined` |

**Dual-rail design**: `x402` settles **on-chain** (EVM, EIP-3009); **OAP-CEX** settles **inside a centralized exchange** (HMAC-signed authorization) — because CEXes are structurally off-chain and forcing x402 onto them is the wrong abstraction. Same `PaymentManager` drives both.

---

## 🤖 Agent framework coverage (35 plugins)

Each plugin is a **thin shim** over the framework-agnostic `OpenAgentPayLlamaTool` kernel — zero reimplemented payment logic.

**TypeScript (28)** — `langchain` · `llamaindex` · `langgraph` · `vercel-ai` · `mastra` · `openai-agents` · `openai-swarm` · `google-adk` · `crewai-flows` · `dspy` · `agno` · `smolagents` · `letta` · `agentscope` · `marvin` · `voltagent` · `spinai` · `motia` · `xsai` · `mcp-tool` · `cloudflare-agents` · `instructor-js` · `inngest-agentkit` · `atomic-agents` · `pydantic-graph` · `llama-stack` · `llamaindex-workflows` · `ai-sdk-v5`

**Python (7)** — `strands` · `autogen` · `crewai` · `semantic-kernel` · `pydantic-ai` · `bedrock-agentcore` · `instructor`

---

## 🧰 SDKs (6 languages)

| Language | Package | Mode |
|:--|:--|:--|
| TypeScript | `@openagentpay/core` | in-process engine + HTTP client |
| Python | `packages/python-sdk` | full async HTTP client |
| Go | `sdks/go` | HTTP client **+ in-process engine** |
| Java | `sdks/java` | HTTP client **+ in-process engine** |
| Rust | `sdks/rust` | async HTTP client |
| — | `@openagentpay/proxy` | LiteLLM-Proxy-style multi-tenant server |

---

## 🏗️ Architecture

<div align="center">
<img src="./svg/platform-architecture.svg" alt="OpenAgentPay 5+1 layer architecture" width="760" />
</div>

```
L0  CLI         oap (config/doctor/conformance/pay/session/audit) · oap-proxy · certifier-cli
L1  Plugin      35 agent-framework adapters (thin shims over one kernel)
L2  Orchestration  PaymentManager · ProtocolRouter · WalletRouter · 7-Layer Guardrail · finance
L3  Protocol    22 ProtocolAdapters (detect → parse → buildRetry → preSubmit)
L4  Wallet      61 WalletConnectors (createInstrument · getBalance · signAuthorization · settle)
L5  Settlement  EVM RPC · CEX REST · Solana RPC · IBC · Hedera Mirror
```

The contract everything implements lives in [`packages/core/src/types.ts`](./packages/core/src/types.ts). Routers are the LiteLLM-Router equivalents. Money is always `{ amountAtomic, decimals, currency }` — never a float.

---

## 🛡️ 7-Layer Guardrail

<div align="center">
<img src="./svg/guardrail-7-layers.svg" alt="7-Layer Guardrail" width="700" />
</div>

A defense-in-depth policy engine inspired by AWS Bedrock AgentCore Payments, open-sourced: spend limits · per-agent budgets · jurisdiction rules · OFAC/Chainalysis/TRM screening · two-person approval · jurisdiction gating · WORM audit. Audit sinks: in-memory · console · DynamoDB · **S3 Object-Lock (WORM, SOX/MRM-grade)**. See [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md).

---

## ✅ Quality & proof

- **4,114 tests** across 5 languages (TS 3,921 · Python 89 · Go 56 · Java 30 · Rust 18), 0 failures, CI-gated on every PR.
- **On-chain verified**: HashKey Chain + Coinbase CDP (Base Sepolia) real txs; Stellar + Aptos + Sui funded via public faucets (`pnpm l2:verify`, 3/3).
- **Dual-CEX live**: Binance Pay + **OKX Demo Trading** — the OAP-CEX `OK-ACCESS-SIGN` recipe is accepted by the real OKX API (`pnpm smoke:okx`), proving the protocol is **not Binance-specific**.
- **L2 EVM live**: Magic + ZeroDev addresses are queryable against the real Circle USDC contract on Base Sepolia (`pnpm smoke:l2evm`).

### Federated conformance certifier

`@openagentpay/certifier` issues **HMAC-signed `ConformanceCertificate`s** and ships a reusable GitHub Actions workflow (`.github/workflows/certify.yml`, `workflow_call`) so any third party can self-certify a wallet/protocol package and obtain a verifiable badge — the `oapconformance.io` engine for letting the ecosystem grow its own connectors.

---

## 🧩 Add your own wallet

Implement the 5-method `WalletConnector` interface and pass the conformance suite:

```ts
interface WalletConnector {
  getCapabilities(): WalletCapabilities;                 // pure
  createInstrument(input): Promise<Instrument>;          // throw on empty userId; idempotent
  getBalance(instrumentId): Promise<Money>;              // throw on unknown id
  signAuthorization(input): Promise<SignedAuthorization>; // throw on wrong protocol
  settle(signed): Promise<SettlementResult>;
}
```

```bash
oap conformance test --pkg packages/wallet-your-wallet   # must pass all 25 tests
```

Full guide → [`CONTRIBUTING.md`](./CONTRIBUTING.md). The 25-test suite is real protection — it caught a silent-accept bug in `wallet-hashkey` during development.

---

## 🗺️ Roadmap

Current main → v1.0 GA arc is tracked in [`docs/ROADMAP.md`](./docs/ROADMAP.md). Highlights shipped: federated certifier · `oap pay/session/audit` · S3-WORM audit · Go/Java in-process engines · AP2 v0.2 A2A · ACP/Web-Monetization/GNAP · dual-CEX live proof.

---

## 🤝 Contributing

We welcome new wallet connectors, protocol adapters, and framework plugins. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the build/test workflow, conformance gates, and "good first contribution" ideas.

---

## 📝 License & disclaimer

Apache-2.0 — see [`LICENSE`](./LICENSE). Maintained by [@neosun100](https://github.com/neosun100).

This is an independent open-source project and does **not** represent the official position of AWS, Coinbase, Stripe, Google, OpenAI, Binance, OKX, HashKey, or any other named party. Testnet/sandbox only until v1.0 GA.
