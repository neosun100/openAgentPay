# OpenAgentPay · Strategic Positioning

> **One-liner**: *LiteLLM let any LLM run with one line of code. **OpenAgentPay lets any AI Agent pay with one line of code**.*

> **Status**: Active · Last updated 2026-05-24 · Version 0.8.0

---

## 1. The category we own

OpenAgentPay is the **unified abstraction layer for Crypto Agent Payments**.

The same way LiteLLM became the de-facto standard for LLM provider abstraction (so you don't lock into OpenAI/Anthropic/Bedrock), OpenAgentPay is the de-facto standard for AI Agent payment provider abstraction (so you don't lock into Coinbase CDP / x402 / a single chain / a single wallet).

**Two pillars hold this position:**

1. **Wallet abstraction** — `WalletConnector` interface (5 methods). Any wallet can plug in: HashKey · Coinbase CDP · Binance · MetaMask · WalletConnect · Solana · (soon) Stripe Privy / Safe / Fireblocks / OKX / Magic.link.
2. **Protocol abstraction** — `ProtocolAdapter` interface (4 methods) + `ProtocolRouter`. Any payment protocol can plug in: x402 v1/v2 · OAP-CEX · AP2 · Solana Pay · MPP · L402 · Stellar SEP-31 · W3C Payment Request · Sui · Aptos · ERC-8004 · Skyfire · Virtuals ACP · Nevermined.

This is **deeper than LiteLLM**: LiteLLM only abstracts providers (one wire format: HTTP+JSON). OpenAgentPay abstracts both **providers AND protocols** because crypto payments fragment along *both* axes.

---

## 2. Why "LiteLLM-for-Payments" is the right framing

### 2.1 What LiteLLM solved that OpenAgentPay must mirror

| LiteLLM concept | Why it became dominant | OpenAgentPay equivalent |
|---|---|---|
| `completion(model, messages)` unified call | Code written for OpenAI runs on Anthropic/Bedrock with **one config change** | `paymentManager.processPayment({sessionId, instrumentId, request})` runs on any wallet/protocol with **one walletProvider change** |
| `litellm/llms/{openai,anthropic,...}.py` | Drop-in adapters with the same shape | `WalletConnector` interface + 6 implementations (today) |
| `litellm.Router` (model_list + fallbacks) | Production teams need failover, load-balance, retries | `ProtocolRouter` (built) + `WalletRouter` (planned, see Roadmap) |
| `litellm-proxy` (`litellm --port 4000`) | Standalone HTTP server with virtual API keys → multi-tenant ready | `oap proxy` server (planned, see Roadmap) |
| `config.yaml` declarative wiring | Ops people don't want to write code to add models | `openagentpay.yaml` (planned, see Roadmap) |
| Callbacks (Langfuse / Helicone / PromptLayer) | Pluggable observability | `AuditSink` interface + InMemory/Console/DynamoDB sinks (built) |
| Cost tracking + budgets | Finance teams need to cap spend | `Session` budget + atomic reservation + `PolicyEngine.amountThreshold/velocityLimit` (built) |
| Guardrails (Lakera / Aporia) | Enterprise needs PII / jailbreak protection | **7-Layer Guardrail** (Policy + Compliance + Audit, all built) |

### 2.2 What payments need that LLMs don't

OpenAgentPay must additionally provide things LiteLLM never had to think about:

| Concept | OpenAgentPay implementation |
|---|---|
| **Atomic budget reservation** under concurrent payments | `SessionManager.checkAndReserve` — DynamoDB optimistic-lock with version |
| **On-chain settlement** with replay protection | EIP-3009 nonce + `transferWithAuthorization` |
| **Sanctions / OFAC / KYT compliance** | `ComplianceChecker` interface (StaticSanctionsChecker built; Chainalysis / TRM Labs in roadmap) |
| **Mandate-based authorization** (W3C Verifiable Credentials) | AP2 ProtocolAdapter + `Mandate` types in core |
| **Multi-asset / multi-chain** | `Money` uses atomic units + decimals (no float drift); 14+ chains supported |
| **Custodial vs self-custodial** | Capability flag `requiresUserApproval` + `settlesOnChain` per connector |
| **Identity / private key isolation** | Layer 6 of Guardrail — Secrets Manager + KMS + Coinbase CDP TEE |

---

## 3. The market we're entering

```
                  ┌──── AWS Bedrock AgentCore Payments (Preview, 2026-05) ────┐
                  │                                                            │
                  │   Wallets:  Coinbase CDP, Stripe Privy                    │
                  │   Protocol: x402 only                                     │
                  │   Region:   us-west-2 / us-east-1 / eu-central / ap-syd  │
                  │                                                            │
                  └────────────────────────────────────────────────────────────┘
                                              │
                                              │  Gap for everyone else:
                                              │  • Asia FSI (HashKey, HKDR, FDUSD)
                                              │  • Asian CEX (Binance, OKX, Bitget)
                                              │  • Web3-native (MetaMask, WalletConnect)
                                              │  • Traditional payments (Alipay, Stripe Card)
                                              ▼
                  ┌─────────────────────────────────────────────────────────────┐
                  │              OpenAgentPay (Open Source, Apache-2.0)         │
                  │                                                              │
                  │   "Any wallet, any protocol, any governance, any framework" │
                  │                                                              │
                  │   ✅ 61 wallets × 22 protocols × 35 frameworks              │
                  │   ✅ 4114 tests (5 langs) · dual-CEX live · 8 L2-confirmed  │
                  │   ✅ Live on AWS — https://d1p7yxa99nxaye.cloudfront.net    │
                  └─────────────────────────────────────────────────────────────┘
```

**Strategic stance: Path D Hybrid** (not a competitor to AWS).

> Customers running Coinbase CDP / Stripe Privy keep using AgentCore Payments **as-is**. Customers needing HashKey / Binance / OKX / MetaMask / Solana / OAP-CEX / AP2 / L402 use OpenAgentPay as an **extension layer** — same `PaymentManager` interface, same `Session`, same business code. Switch wallets with one config line.

When AWS opens up `CreatePaymentConnector` BYO support (signaled in their roadmap), OpenAgentPay's connectors register on day one as the reference implementation for non-CDP/non-Privy wallets.

---

## 4. Why this matters NOW (timing)

| Signal | Date | Why it matters |
|---|---|---|
| AWS Bedrock AgentCore Payments Preview | 2026-05-07 | First cloud-platform-level Agent payment infrastructure |
| Coinbase x402 Foundation forming | Q1 2026 | Protocol governance moving from single-vendor to standards body |
| Google AP2 / Agent Payments Protocol | 2026-04 | Big-tech alignment on mandate-based authorization |
| Stripe + Tempo MPP draft | Q1 2026 | Traditional payments meeting agent payments |
| HashKey Chain mainnet, HKDR roadmap | 2026 | Asian regulated stablecoin infrastructure shipping |
| ERC-8004 Trustless Agents | 2026 | On-chain agent identity standard emerging |

**Conclusion**: The category is being defined right now, in 2026. The reference implementation that ships first, supports the most providers, and has the cleanest abstraction wins. LiteLLM did this for LLMs in 2023-2024; the same window is open for payments in 2026.

---

## 5. Current state (v0.8.0, 2026-05-24)

### 5.1 What's built

```
TypeScript monorepo (pnpm) + Python uv workspace
─────────────────────────────────────────────────
31 packages · 2 apps · 12 scripts · 358 passing tests

L1 Framework Plugins ×7
  TS:     langchain · llamaindex · mastra
  Python: strands · autogen · crewai · semantic-kernel

L2 Core Orchestration
  PaymentManager (InMemory + DynamoDB pluggable)
  SessionManager (InMemory mutex + DynamoDB optimistic-lock)
  ProtocolRouter (first-match-wins + AP2 mandate bridging)
  GovernanceManager (preCheck + recordSuccess/Failure)

L3 Protocol Adapters ×13
  x402-v1/v2 · cex-pay-v0.1 · ap2-v0.1 · solana-pay-v1
  mpp-v0.1 · l402-v1 · stellar-sep31-v1 · w3c-payment-v1
  sui-pay-v1 · aptos-pay-v1 · erc8004-v1 · skyfire-v1
  virtuals-acp-v1 · nevermined-v1

L4 Wallet Connectors ×6
  hashkey · coinbase-cdp · binance · metamask · walletconnect · solana

L5 Settlement
  EVM RPC · CEX REST API · Solana RPC

L6 Identity (built into deployment)
  AWS Secrets Manager + KMS · Coinbase CDP TEE

L7 Audit
  InMemorySink · ConsoleSink · DynamoDBAuditSink (with byKind/byEventId GSI)

Compliance
  StaticSanctionsChecker · CompositeComplianceChecker · DEMO_SANCTIONS_LIST

Policy (6 built-in)
  velocityLimit · amountThreshold · merchantWhitelist/Blacklist
  walletProviderWhitelist · timeOfDay

Production deployment
  AWS us-east-1: API Gateway HTTP API → Lambda → DynamoDB + Secrets Manager
  CloudFront → S3 (web UI)
  Live URL: https://d1p7yxa99nxaye.cloudfront.net
```

### 5.2 On-chain verification

| Network | TX | Outcome |
|---|---|---|
| HashKey Chain Testnet | `0xff8a175e...` | Python ref impl |
| HashKey Chain Testnet | `0x5c10e2ae...` | TypeScript impl |
| HashKey Chain Testnet | `0xd18cb0f1...` | Live AWS Lambda |
| Base Sepolia | `0xb6e6674f...` | Coinbase CDP via CloudFront → Lambda |

Two independent implementations (Python + TypeScript) producing identical on-chain effects — proves the protocol abstraction is correct.

---

## 6. Roadmap (next 3 months, 3 waves)

### 6.1 Wave 1 — Productize the LiteLLM-style developer experience (2-3 weeks)

| # | Item | Why | Status |
|---|---|---|---|
| 1 | `packages/proxy` — standalone HTTP/gRPC OpenAgentPay server | LiteLLM Proxy equivalent — multi-tenant, virtual API keys | 🚧 Started 2026-05-24 |
| 2 | `packages/cli` — `oap` CLI (`oap proxy start`, `oap pay`, `oap doctor`) | Operational ergonomics | 🟡 Planned |
| 3 | `packages/config` — `openagentpay.yaml` schema + loader | Declarative wiring (config-driven, no code) | 🟡 Planned |
| 4 | `packages/conformance` — WalletConnector + ProtocolAdapter test suite | Lets third parties self-certify | ✅ Done + `@openagentpay/certifier` (federated, signed certs + `certify.yml`) |
| 5 | `docs/MIGRATION-FROM-LITELLM.md` | Cognitive bridge for LiteLLM users | 🟡 Planned |
| 6 | Updated README to reflect current reality | — | ✅ Done (refreshed to v0.19: 61 wallets / 22 protocols / 35 frameworks) |

### 6.2 Wave 2 — High-ROI wallet + governance gaps (3-4 weeks)

| # | Item | Why |
|---|---|---|
| 7 | `wallet-stripe-privy` | The other half of AgentCore native — closes Path D loop |
| 8 | `wallet-okx` / `wallet-hashkey-pro` | OAP-CEX 2nd/3rd implementation — proves protocol generality |
| 9 | `wallet-safe` (Gnosis multi-sig) | Enterprise must-have |
| 10 | `wallet-fireblocks` (MPC custody) | Enterprise must-have |
| 11 | `governance/checkers/ChainalysisChecker` | Production-grade KYT |
| 12 | `governance/sinks/S3WormAuditSink` | WORM compliance for SOX/MRM |
| 13 | `core/orchestration/WalletRouter` (fallback / cost / latency) | LiteLLM Router for wallets |

### 6.3 Wave 3 — Long-tail extension + ecosystem (4-6 weeks)

| # | Item |
|---|---|
| 14 | Plugins: Vercel AI SDK · LangGraph · PydanticAI · Bedrock AgentCore Plugin · Genkit · Spring AI |
| 15 | Wallets: Magic.link · Crossmint · Anchorage · Web3Auth |
| 16 | Protocols: ERC-7777 · Tron USDT · Open Payments (Interledger) |
| 17 | Spend Analytics Dashboard (5th tab in demo-web) |
| 18 | Refund / Subscription / Receipt API |
| 19 | Python / Go / Java / Rust SDK clients |

---

## 7. What we will NOT do (explicit non-goals)

- ❌ **We will not build merchant-side infrastructure** (invoice generation, sweepers). We focus on the *agent buyer* side. Merchant side is Visa/Mastercard/Stripe territory — complementary, not competitive.
- ❌ **We will not compete with AgentCore Payments**. Path D Hybrid keeps the two coexisting; OpenAgentPay positions as the official extension surface for non-CDP/non-Privy wallets.
- ❌ **We will not build KYC/AML implementations from scratch**. The `ComplianceChecker` interface integrates with Chainalysis / TRM / Elliptic — they are the experts.
- ❌ **We will not write production-grade connectors for >2-3 wallets ourselves**. After Wave 2, new connector contributions come from wallet providers themselves (Linux Foundation model). The `conformance` package is what makes this scalable — pass the tests, get certified, ship to npm.
- ❌ **We will not lock to any single stablecoin**. USDC / USDT / FDUSD / HKDR / any EIP-3009-compliant ERC-20 → automatic support.
- ❌ **We will not move to mainnet with real funds before v1.0 GA**. Testnet-first. v0.x is for protocol validation, not custodial production.

---

## 8. The 30-second pitch (for talks, README, GitHub topics)

> OpenAgentPay is the open, pluggable abstraction layer for crypto agent payments. The same way LiteLLM lets you call OpenAI, Anthropic, Bedrock, and 100+ models with one line of code, OpenAgentPay lets your AI agent pay through HashKey Chain, Coinbase CDP, Binance Pay, MetaMask, Solana, and any future wallet — across x402, AP2, OAP-CEX, Solana Pay, MPP, L402, and any future protocol — with one config change. Built for AWS Bedrock AgentCore. Apache-2.0. 358 tests passing. Live on AWS.

GitHub topics: `agent-payments` · `litellm` · `x402` · `agentcore` · `usdc` · `eip-3009` · `crypto-payments` · `ai-agent` · `payment-protocol` · `wallet-abstraction`

---

*Maintained by [Neo Sun](https://github.com/neosun100). Issues and PRs welcome.*
