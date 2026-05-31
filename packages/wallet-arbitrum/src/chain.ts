/**
 * Arbitrum network configuration constants.
 *
 * Arbitrum Sepolia is an Optimistic-Rollup L2 testnet for the Arbitrum One
 * mainnet. Circle has deployed official testnet USDC there with full EIP-3009
 * support, so any x402 / transferWithAuthorization flow that works on Base
 * Sepolia works here unchanged (only chainId + verifyingContract differ).
 *
 * Source: https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers
 *         https://developers.circle.com/stablecoins/usdc-on-test-networks
 *
 * @license Apache-2.0
 */

import type { Chain } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

// ============================================================================
//  Chain definitions (viem-compatible — prefer viem builtins)
// ============================================================================

/** Arbitrum One Mainnet — chainId 42161 (viem builtin). */
export const arbitrumMainnet: Chain = arbitrum;

/** Arbitrum Sepolia Testnet — chainId 421614 (viem builtin). */
export const arbitrumSepoliaTestnet: Chain = arbitrumSepolia;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * Circle's official testnet USDC on Arbitrum Sepolia (chainId 421614).
 * Implements full EIP-3009 (`transferWithAuthorization`) with the same
 * typehashes as Circle USDC on Base / Ethereum.
 *
 * Source: https://developers.circle.com/stablecoins/usdc-on-test-networks
 */
export const ARBITRUM_SEPOLIA_USDC =
  "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;

/**
 * Circle's official USDC on Arbitrum One Mainnet (chainId 42161).
 * Kept for reference; OpenAgentPay defaults to testnet until v1.0 GA.
 */
export const ARBITRUM_MAINNET_USDC =
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

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
