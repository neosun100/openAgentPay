/**
 * Chain registry for Circle Programmable Wallets connector.
 * ========================================================
 *
 * Circle's developer-controlled wallets operate USDC-natively across several
 * EVM testnets. We support three config-selectable networks:
 *
 *   - Base Sepolia    (84532)    — Circle's primary x402 testnet
 *   - Polygon Amoy    (80002)    — Circle CCTP testnet
 *   - Ethereum Sepolia(11155111) — canonical L1 testnet
 *
 * USDC addresses are Circle's official testnet deployments. All are EIP-3009
 * (transferWithAuthorization) capable, which is what x402-v1 settles against.
 *
 * We define viem-compatible Chain objects inline (no viem/chains import) so the
 * package stays decoupled from viem's chain catalog versioning.
 *
 * @license Apache-2.0
 */

import type { Address, Chain } from "viem";

export type CircleNetwork = "base-sepolia" | "polygon-amoy" | "eth-sepolia";

export interface CircleChainInfo {
  readonly network: CircleNetwork;
  readonly chain: Chain;
  /** Circle's official testnet USDC (EIP-3009 capable). */
  readonly usdc: Address;
  /** Explorer base for tx links. */
  readonly explorerTxBase: string;
}

const baseSepolia: Chain = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
  },
  blockExplorers: {
    default: { name: "Basescan", url: "https://sepolia.basescan.org" },
  },
  testnet: true,
};

const polygonAmoy: Chain = {
  id: 80002,
  name: "Polygon Amoy",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc-amoy.polygon.technology"] },
  },
  blockExplorers: {
    default: { name: "PolygonScan Amoy", url: "https://amoy.polygonscan.com" },
  },
  testnet: true,
};

const ethSepolia: Chain = {
  id: 11155111,
  name: "Ethereum Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.sepolia.org"] },
  },
  blockExplorers: {
    default: { name: "Etherscan Sepolia", url: "https://sepolia.etherscan.io" },
  },
  testnet: true,
};

export const CIRCLE_CHAINS: Readonly<Record<CircleNetwork, CircleChainInfo>> = {
  "base-sepolia": {
    network: "base-sepolia",
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerTxBase: "https://sepolia.basescan.org/tx/",
  },
  "polygon-amoy": {
    network: "polygon-amoy",
    chain: polygonAmoy,
    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    explorerTxBase: "https://amoy.polygonscan.com/tx/",
  },
  "eth-sepolia": {
    network: "eth-sepolia",
    chain: ethSepolia,
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    explorerTxBase: "https://sepolia.etherscan.io/tx/",
  },
} as const;

export function resolveCircleChain(network: CircleNetwork): CircleChainInfo {
  const info = CIRCLE_CHAINS[network];
  if (!info) {
    throw new Error(`Unknown Circle network: ${network}`);
  }
  return info;
}

export function txExplorerUrl(network: CircleNetwork, txHash: string): string {
  return `${resolveCircleChain(network).explorerTxBase}${txHash}`;
}
