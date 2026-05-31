/**
 * scripts/l2-faucet-verify.ts
 * ===========================
 *
 * Proves L2 (real testnet on-chain) reachability for the credential-free
 * chains: it uses each wallet connector's in-process `generate*Keypair()`
 * to mint a REAL address, hits that chain's public faucet (no signup, no
 * CAPTCHA), and confirms the account is now live on-chain.
 *
 * This is the bridge from "L1 conformance-green" (signature crypto real,
 * broadcast deferred) to "L2 on-chain" (account funded + queryable). Run:
 *
 *     pnpm l2:verify
 *
 * Chains covered (public faucets, no credentials needed):
 *   - Stellar testnet  (Friendbot — funds + activates the account)
 *   - Aptos devnet     (faucet mint — creates the account's CoinStore)
 *   - Sui devnet       (v2 faucet — funds 10 SUI, returns a transferTxDigest)
 *
 * L1-only (faucet blocks datacenter IPs or requires CAPTCHA — connector is
 * still conformance-green, just not auto-fundable from CI):
 *   - Solana devnet    (public RPC requestAirdrop rate-limits/blocks; needs Helius key)
 *   - TRON Shasta      (faucet is now a web form behind CAPTCHA)
 *   - Polkadot Westend (Matrix/Element-gated faucet)
 *
 * @license Apache-2.0
 */

import { generateStellarKeypair } from "../packages/wallet-stellar/src/real-signer.js";
import { generateAptosKeypair } from "../packages/wallet-aptos/src/real-signer.js";
import { generateSuiKeypair } from "../packages/wallet-sui/src/real-signer.js";

interface L2Result {
  readonly chain: string;
  readonly address: string;
  readonly funded: boolean;
  readonly onChainConfirmed: boolean;
  readonly explorer: string;
  readonly note: string;
}

async function verifyStellar(): Promise<L2Result> {
  const kp = generateStellarKeypair();
  const explorer = `https://stellar.expert/explorer/testnet/account/${kp.address}`;
  try {
    const fund = await fetch(`https://friendbot.stellar.org/?addr=${kp.address}`);
    if (fund.status !== 200) {
      return {
        chain: "stellar-testnet",
        address: kp.address,
        funded: false,
        onChainConfirmed: false,
        explorer,
        note: `friendbot HTTP ${fund.status}`,
      };
    }
    await sleep(3000);
    const acc = await fetch(
      `https://horizon-testnet.stellar.org/accounts/${kp.address}`
    );
    let balance = "(pending)";
    if (acc.status === 200) {
      const j = (await acc.json()) as {
        balances?: ReadonlyArray<{ asset_type: string; balance: string }>;
      };
      const native = j.balances?.find((b) => b.asset_type === "native");
      balance = native?.balance ?? "(pending)";
    }
    return {
      chain: "stellar-testnet",
      address: kp.address,
      funded: true,
      onChainConfirmed: acc.status === 200,
      explorer,
      note: `XLM balance ${balance}`,
    };
  } catch (err) {
    return {
      chain: "stellar-testnet",
      address: kp.address,
      funded: false,
      onChainConfirmed: false,
      explorer,
      note: `error ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function verifyAptos(): Promise<L2Result> {
  const kp = generateAptosKeypair() as unknown as {
    address?: string;
    accountAddress?: string;
  };
  const address = kp.address ?? kp.accountAddress ?? "";
  const explorer = `https://explorer.aptoslabs.com/account/${address}?network=devnet`;
  try {
    const fund = await fetch(
      `https://faucet.devnet.aptoslabs.com/mint?address=${address}&amount=100000000`,
      { method: "POST" }
    );
    if (fund.status !== 200) {
      return {
        chain: "aptos-devnet",
        address,
        funded: false,
        onChainConfirmed: false,
        explorer,
        note: `faucet HTTP ${fund.status}`,
      };
    }
    await sleep(4000);
    const res = await fetch(
      `https://fullnode.devnet.aptoslabs.com/v1/accounts/${address}/resources`
    );
    return {
      chain: "aptos-devnet",
      address,
      funded: true,
      onChainConfirmed: res.status === 200,
      explorer,
      note: res.status === 200 ? "CoinStore resource live" : `resources HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      chain: "aptos-devnet",
      address,
      funded: false,
      onChainConfirmed: false,
      explorer,
      note: `error ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function verifySui(): Promise<L2Result> {
  const kp = generateSuiKeypair() as unknown as { address: string };
  const address = kp.address;
  const explorer = `https://suiscan.xyz/devnet/account/${address}`;
  try {
    const fund = await fetch("https://faucet.devnet.sui.io/v2/gas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
    });
    if (fund.status !== 200) {
      return {
        chain: "sui-devnet",
        address,
        funded: false,
        onChainConfirmed: false,
        explorer,
        note: `faucet HTTP ${fund.status}`,
      };
    }
    await sleep(5000);
    const bal = await fetch("https://fullnode.devnet.sui.io:443", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getBalance",
        params: [address],
      }),
    });
    let total = "(pending)";
    let confirmed = false;
    if (bal.status === 200) {
      const j = (await bal.json()) as {
        result?: { totalBalance?: string };
      };
      total = j.result?.totalBalance ?? "(pending)";
      confirmed = total !== "(pending)" && total !== "0";
    }
    return {
      chain: "sui-devnet",
      address,
      funded: true,
      onChainConfirmed: confirmed,
      explorer,
      note: `SUI balance ${total} (MIST)`,
    };
  } catch (err) {
    return {
      chain: "sui-devnet",
      address,
      funded: false,
      onChainConfirmed: false,
      explorer,
      note: `error ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log(
    "\n" +
      "─".repeat(80) +
      "\n🌊  OpenAgentPay L2 Faucet Verification — real testnet on-chain proof\n" +
      "─".repeat(80)
  );
  const results = await Promise.all([verifyStellar(), verifyAptos(), verifySui()]);
  let confirmed = 0;
  for (const r of results) {
    const status = r.onChainConfirmed ? "✅ ON-CHAIN" : r.funded ? "🟡 funded" : "❌ failed";
    console.log(`\n  ${status}  ${r.chain}`);
    console.log(`     addr:     ${r.address}`);
    console.log(`     note:     ${r.note}`);
    console.log(`     explorer: ${r.explorer}`);
    if (r.onChainConfirmed) confirmed++;
  }
  console.log(
    "\n" +
      "─".repeat(80) +
      `\n📊  ${confirmed}/${results.length} chains confirmed on-chain (L1→L2)\n` +
      "─".repeat(80) +
      "\n"
  );
  if (confirmed === 0) process.exitCode = 1;
}

void main();
