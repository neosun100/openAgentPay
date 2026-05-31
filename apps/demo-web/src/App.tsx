import { useEffect, useState } from "react";
import { ActivityLog } from "./ActivityLog.js";
import { Sidebar } from "./Sidebar.js";
import { RunDemoTab } from "./RunDemoTab.js";
import { HowItWorksTab } from "./HowItWorksTab.js";
import { AiAgentTab } from "./AiAgentTab.js";
import { GuardrailTab } from "./GuardrailTab.js";
import { SpendAnalyticsTab } from "./SpendAnalyticsTab.js";
import { WalletMatrixTab } from "./WalletMatrixTab.js";
import { api, type WalletEntry } from "./api.js";

type TabId = "run" | "how" | "agent" | "guardrail" | "spend" | "matrix";

/**
 * Roadmap chips — wallets we plan to add but haven't implemented yet.
 *
 * NOTE: providers now served live by /api/wallets (solana, stellar, sui, aptos,
 * tron, cosmos, stripe-privy, circle, magic, zerodev, hedera, …) have been
 * removed from this list — they render automatically from `availableWallets`.
 * Only genuinely-future wallets remain here.
 */
const ROADMAP_WALLETS: ReadonlyArray<{
  id: string;
  label: string;
  chain: string;
  protocol: string;
  category: "evm" | "managed" | "cex" | "trad" | "non-evm";
}> = [
  // EVM self-custodial (x402)
  { id: "metamask", label: "MetaMask", chain: "EVM", protocol: "x402", category: "evm" },
  { id: "walletconnect", label: "WalletConnect", chain: "EVM", protocol: "x402", category: "evm" },
  { id: "rabby", label: "Rabby", chain: "EVM", protocol: "x402", category: "evm" },
  { id: "safe", label: "Safe (multi-sig)", chain: "EVM", protocol: "x402", category: "evm" },

  // Managed / institutional
  { id: "fireblocks", label: "Fireblocks", chain: "EVM", protocol: "x402", category: "managed" },
  { id: "crossmint", label: "Crossmint", chain: "EVM", protocol: "x402", category: "managed" },

  // Non-EVM chains
  { id: "lightning", label: "Lightning Network", chain: "BTC", protocol: "LN-402", category: "non-evm" },

  // CEX (OAP-CEX)
  { id: "okx-pay", label: "OKX Pay", chain: "CEX", protocol: "OAP-CEX", category: "cex" },
  { id: "bitget", label: "Bitget Wallet", chain: "CEX", protocol: "OAP-CEX", category: "cex" },
  { id: "bybit", label: "Bybit Pay", chain: "CEX", protocol: "OAP-CEX", category: "cex" },
  { id: "hashkey-pro", label: "HashKey Pro", chain: "CEX", protocol: "OAP-CEX", category: "cex" },

  // Traditional payment
  { id: "alipay", label: "Alipay", chain: "Trad", protocol: "OAP-CEX", category: "trad" },
  { id: "wechat-pay", label: "WeChat Pay", chain: "Trad", protocol: "OAP-CEX", category: "trad" },
  { id: "stripe-card", label: "Stripe Card", chain: "Trad", protocol: "AP2", category: "trad" },
  { id: "paypal", label: "PayPal", chain: "Trad", protocol: "AP2", category: "trad" },
  { id: "apple-pay", label: "Apple Pay", chain: "Trad", protocol: "W3C-PR", category: "trad" },
];

export function App() {
  const [tab, setTab] = useState<TabId>("run");
  const [walletProvider, setWalletProvider] = useState("hashkey-chain");
  const [availableWallets, setAvailableWallets] = useState<WalletEntry[]>([]);

  useEffect(() => {
    api
      .wallets()
      .then((resp) => {
        setAvailableWallets(resp.wallets);
        // Use server's default if user didn't pre-select
        if (
          resp.defaultProvider &&
          !resp.wallets.some((w) => w.walletProvider === walletProvider)
        ) {
          setWalletProvider(resp.defaultProvider);
        }
      })
      .catch((e: Error) => console.warn("Failed to load wallets:", e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeWallet = availableWallets.find(
    (w) => w.walletProvider === walletProvider
  );

  return (
    <div className="app">
      <header className="banner">
        <div className="banner-left">
          <span style={{ fontSize: 20 }}>🌐</span>
          <h1>OpenAgentPay</h1>
          <span className="banner-tagline">
            Open · Pluggable · Agent Payments
          </span>
        </div>
        <div className="banner-right">
          <a
            href="https://github.com/neosun100/openAgentPay"
            target="_blank"
            rel="noreferrer"
            className="banner-github"
          >
            GitHub →
          </a>
        </div>
      </header>

      <div className="capability-bar">
        <div className="capability-section">
          <span className="capability-label">Live</span>
          {availableWallets.length === 0 && (
            <span className="chip chip-loading">Loading…</span>
          )}
          {availableWallets.map((w) => (
            <button
              key={w.walletProvider}
              className={`chip chip-button ${
                w.walletProvider === walletProvider
                  ? "chip-active"
                  : "chip-available"
              }`}
              onClick={() => setWalletProvider(w.walletProvider)}
              title={`Switch to ${w.displayName} on ${w.chainName}`}
            >
              <span className="chip-dot" />
              {w.displayName}
              <span className="chip-meta">· {w.chainName}</span>
            </button>
          ))}
        </div>
        <div className="capability-section capability-roadmap">
          <span className="capability-label">Roadmap</span>
          {ROADMAP_WALLETS.map((w) => (
            <span
              key={w.id}
              className={`chip chip-coming chip-cat-${w.category}`}
              title={`Planned: ${w.label} — ${w.chain} via ${w.protocol}`}
            >
              {w.label}
              <span className="chip-meta">· {w.protocol}</span>
            </span>
          ))}
          <span
            className="chip chip-ellipsis"
            title="Any wallet implementing the WalletConnector interface (5 methods) can plug in"
          >
            +∞
          </span>
        </div>
      </div>

      <nav className="tabs">
        <button
          className={tab === "run" ? "active" : ""}
          onClick={() => setTab("run")}
        >
          Run Demo
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>
            4 步链上结算
          </div>
        </button>
        <button
          className={tab === "how" ? "active" : ""}
          onClick={() => setTab("how")}
        >
          How It Works
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>
            8 步全链路
          </div>
        </button>
        <button
          className={tab === "agent" ? "active" : ""}
          onClick={() => setTab("agent")}
        >
          AI Agent
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>
            Strands 自主付费
          </div>
        </button>
        <button
          className={tab === "guardrail" ? "active" : ""}
          onClick={() => setTab("guardrail")}
        >
          Guardrail 🛡️
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>
            7 层风控可视化
          </div>
        </button>
        <button
          className={tab === "spend" ? "active" : ""}
          onClick={() => setTab("spend")}
        >
          Spend 📊
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>
            实时花费分析
          </div>
        </button>
        <button
          className={tab === "matrix" ? "active" : ""}
          onClick={() => setTab("matrix")}
        >
          Matrix 🔗
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>
            钱包 × 协议全景
          </div>
        </button>
        {activeWallet && (
          <div className="tab-status">
            <span className="tab-status-pill">
              <span
                className="status-dot status-active"
                title="Live"
              />
              {activeWallet.chainName} · {activeWallet.tokenLabel}
            </span>
          </div>
        )}
      </nav>

      <main>
        <Sidebar
          walletProvider={walletProvider}
          onWalletChange={setWalletProvider}
        />
        {tab === "run" && <RunDemoTab walletProvider={walletProvider} />}
        {tab === "how" && <HowItWorksTab />}
        {tab === "agent" && <AiAgentTab walletProvider={walletProvider} />}
        {tab === "guardrail" && (
          <GuardrailTab walletProvider={walletProvider} />
        )}
        {tab === "spend" && <SpendAnalyticsTab />}
        {tab === "matrix" && <WalletMatrixTab />}
      </main>

      <ActivityLog />
    </div>
  );
}
