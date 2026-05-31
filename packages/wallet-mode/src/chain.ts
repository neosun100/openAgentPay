/**
 * Mode Sepolia network configuration constants.
 *
 * Mode is an Ethereum L2 built on the OP Stack (Optimism's rollup framework),
 * the same lineage as Base. Mode Sepolia is its public testnet (chainId 919).
 * Because it is OP-Stack/EVM-equivalent, any x402 / EIP-3009
 * (transferWithAuthorization) flow that works against USDC on Base works here
 * unchanged — only chainId + verifyingContract differ.
 *
 * We hand-roll the `Chain` definition (rather than relying on a viem built-in)
 * so the RPC + explorer endpoints match the values pinned in the OpenAgentPay
 * spec and stay stable across viem releases.
 *
 * @license Apache-2.0
 */

import { type Address, type Chain, defineChain } from "viem";

// ============================================================================
//  Chain definition
// ============================================================================

/** Numeric chainId for Mode Sepolia. */
export const MODE_SEPOLIA_CHAIN_ID = 919 as const;

/** Mode Sepolia testnet — chainId 919 (OP Stack L2). */
export const modeSepoliaChain: Chain = defineChain({
  id: MODE_SEPOLIA_CHAIN_ID,
  name: "Mode Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.mode.network"] },
  },
  blockExplorers: {
    default: {
      name: "Mode Sepolia Explorer",
      url: "https://sepolia.explorer.mode.network",
    },
  },
  testnet: true,
});

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC on Mode Sepolia (placeholder, 6 decimals).
 *
 * NOTE: Mode Sepolia does not yet have a canonical Circle-issued USDC at a
 * well-known fixed address the way Base Sepolia does. This is a placeholder
 * EIP-3009 USDC address; override via `MODE_SEPOLIA_USDC` / the connector
 * config `tokenAddress` once a real testnet USDC is deployed. The signing
 * path is byte-for-byte identical regardless of the address.
 */
export const MODE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

// ============================================================================
//  Helpers
// ============================================================================

/** Get the explorer URL for a tx hash. */
export function txExplorerUrl(chain: Chain, txHash: string): string {
  const base = chain.blockExplorers?.default?.url;
  if (!base) throw new Error(`No block explorer configured for chain ${chain.id}`);
  return `${base}/tx/${txHash.startsWith("0x") ? txHash : "0x" + txHash}`;
}

/** Get the explorer URL for an address. */
export function addressExplorerUrl(chain: Chain, address: string): string {
  const base = chain.blockExplorers?.default?.url;
  if (!base) throw new Error(`No block explorer configured for chain ${chain.id}`);
  return `${base}/address/${address}`;
}
