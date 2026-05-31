/**
 * WalletMatrixTab — the "wallets × protocols" coverage grid.
 *
 * Rows  = wallet connectors (live ones pulled from GET /api/wallets, plus a
 *         few genuinely-future roadmap rows rendered greyed).
 * Cols  = protocol families (x402, Solana-Pay, Stellar-SEP31, …).
 *
 * A filled cell (✓ + live-green dot) marks a supported wallet×protocol pair.
 * Live coverage is derived from the connector's known protocol map; roadmap
 * rows show only their planned protocol(s) as dim ✓.
 *
 * The whole point of OpenAgentPay: one interface, every wallet, every protocol.
 *
 * @license Apache-2.0
 */

import { useEffect, useMemo, useState } from "react";
import { api, type WalletEntry } from "./api.js";

/** Protocol family columns — the 12 headline protocol families. */
const PROTOCOLS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "x402", label: "x402" },
  { id: "solana-pay", label: "Solana-Pay" },
  { id: "stellar-sep31", label: "Stellar-SEP31" },
  { id: "sui-pay", label: "Sui-Pay" },
  { id: "aptos-pay", label: "Aptos-Pay" },
  { id: "tron-usdt", label: "TRON-USDT" },
  { id: "cosmos-ibc", label: "Cosmos-IBC" },
  { id: "hedera-hcs", label: "Hedera-HCS" },
  { id: "oap-cex", label: "OAP-CEX" },
  { id: "l402", label: "L402" },
  { id: "ap2", label: "AP2" },
  { id: "open-payments", label: "Open-Payments" },
];

/**
 * Which protocol families each *live* wallet provider supports. Keyed by the
 * `walletProvider` id returned from /api/wallets. Any provider not listed here
 * falls back to ["x402"] (every EVM connector speaks x402).
 */
const LIVE_COVERAGE: Readonly<Record<string, ReadonlyArray<string>>> = {
  "hashkey-chain": ["x402", "ap2", "oap-cex"],
  "coinbase-cdp": ["x402", "ap2", "open-payments"],
  solana: ["solana-pay", "x402"],
  stellar: ["stellar-sep31", "open-payments"],
  hedera: ["hedera-hcs", "x402"],
  sui: ["sui-pay"],
  aptos: ["aptos-pay"],
  tron: ["tron-usdt", "oap-cex"],
  cosmos: ["cosmos-ibc"],
  "stripe-privy": ["x402", "ap2"],
  circle: ["x402", "ap2"],
  magic: ["x402", "ap2"],
  zerodev: ["x402", "ap2"],
};

/** Roadmap rows — wallets not yet served live. Greyed in the grid. */
const ROADMAP_ROWS: ReadonlyArray<{
  id: string;
  label: string;
  chain: string;
  protocols: ReadonlyArray<string>;
}> = [
  { id: "fireblocks", label: "Fireblocks", chain: "EVM", protocols: ["x402", "ap2"] },
  { id: "okx-pay", label: "OKX Pay", chain: "CEX", protocols: ["oap-cex"] },
  { id: "lightning", label: "Lightning", chain: "BTC", protocols: ["l402"] },
];

interface MatrixRow {
  readonly id: string;
  readonly label: string;
  readonly chain: string;
  readonly live: boolean;
  readonly supported: ReadonlySet<string>;
}

function buildRows(liveWallets: ReadonlyArray<WalletEntry>): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const w of liveWallets) {
    const protos = LIVE_COVERAGE[w.walletProvider] ?? ["x402"];
    rows.push({
      id: w.walletProvider,
      label: w.displayName,
      chain: w.chainName,
      live: true,
      supported: new Set(protos),
    });
  }
  for (const r of ROADMAP_ROWS) {
    // Don't duplicate a roadmap row if it somehow went live.
    if (rows.some((row) => row.id === r.id)) continue;
    rows.push({
      id: r.id,
      label: r.label,
      chain: r.chain,
      live: false,
      supported: new Set(r.protocols),
    });
  }
  return rows;
}

export function WalletMatrixTab(): JSX.Element {
  const [wallets, setWallets] = useState<ReadonlyArray<WalletEntry>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .wallets()
      .then((r) => {
        if (!cancelled) setWallets(r.wallets);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => buildRows(wallets), [wallets]);
  const liveCount = rows.filter((r) => r.live).length;
  const totalCells = rows.reduce((acc, r) => acc + r.supported.size, 0);

  return (
    <section className="content tab-matrix">
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Wallet × Protocol Matrix</h2>
          <p style={{ color: "var(--fg-dim)", margin: "4px 0 0", fontSize: 13 }}>
            一个接口路由所有钱包 × 所有协议 — LiteLLM for Crypto Agent Payments。
          </p>
        </div>
        <div className="matrix-stat">
          <span className="matrix-stat-num">{liveCount}</span> live wallets
          <span className="matrix-stat-sep">·</span>
          <span className="matrix-stat-num">18</span> protocols
          <span className="matrix-stat-sep">·</span>
          <span className="matrix-stat-num">1</span> interface
        </div>
      </header>

      {error && (
        <div
          style={{
            padding: 12,
            border: "1px solid #ff7a7a",
            borderRadius: 6,
            color: "#ff7a7a",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 16,
          fontSize: 11,
          color: "var(--fg-dim)",
          margin: "12px 0 16px",
          flexWrap: "wrap",
        }}
      >
        <span>
          <span className="matrix-cell-live" style={{ marginRight: 6 }}>
            <span className="matrix-dot" />✓
          </span>
          Live coverage
        </span>
        <span>
          <span className="matrix-cell-roadmap" style={{ marginRight: 6 }}>
            ✓
          </span>
          Roadmap
        </span>
        <span>
          {loading
            ? "loading wallets…"
            : `${liveCount} live wallets · ${totalCells} supported pairs`}
        </span>
      </div>

      <div className="matrix-scroll">
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="matrix-th-wallet">Wallet</th>
              <th className="matrix-th-chain">Chain</th>
              {PROTOCOLS.map((p) => (
                <th key={p.id} className="matrix-th-proto" title={p.label}>
                  <span className="matrix-th-proto-text">{p.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={row.live ? "matrix-row-live" : "matrix-row-roadmap"}
              >
                <td className="matrix-td-wallet">
                  {row.live && <span className="matrix-row-dot" />}
                  {row.label}
                </td>
                <td className="matrix-td-chain">{row.chain}</td>
                {PROTOCOLS.map((p) => {
                  const on = row.supported.has(p.id);
                  if (!on) return <td key={p.id} className="matrix-td-empty" />;
                  return (
                    <td
                      key={p.id}
                      className={
                        row.live ? "matrix-td-on-live" : "matrix-td-on-roadmap"
                      }
                      title={`${row.label} supports ${p.label}`}
                    >
                      {row.live ? (
                        <span className="matrix-cell-live">
                          <span className="matrix-dot" />✓
                        </span>
                      ) : (
                        <span className="matrix-cell-roadmap">✓</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer
        style={{
          fontSize: 11,
          color: "var(--fg-dim)",
          paddingTop: 12,
          marginTop: 16,
          borderTop: "1px solid var(--bd-faint)",
        }}
      >
        Live rows are sourced from <code>/api/wallets</code> in real time.
        Roadmap rows (greyed) ship in upcoming versions. Any wallet implementing
        the 5-method <code>WalletConnector</code> interface plugs into every
        protocol column automatically.
      </footer>
    </section>
  );
}
