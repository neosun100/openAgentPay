/**
 * Optimism (OP Sepolia) network configuration.
 *
 * OP Sepolia is the canonical Optimism L2 testnet (chainId 11155420). We
 * reuse viem's builtin `optimismSepolia` chain definition so RPC URLs and
 * block-explorer metadata stay in sync with upstream.
 *
 * Source: https://docs.optimism.io/builders/tools/build/networks
 *
 * @license Apache-2.0
 */

import type { Chain } from "viem";
import { optimismSepolia } from "viem/chains";

// ============================================================================
//  Chain definition (viem-compatible)
// ============================================================================

/** OP Sepolia testnet — chainId 11155420 (viem builtin). */
export const optimismSepoliaChain: Chain = optimismSepolia;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * Circle's native USDC on OP Sepolia. 6 decimals, full EIP-3009 support
 * (transferWithAuthorization), so any x402 flow that works against Circle
 * USDC on Base Sepolia works here unchanged — only chainId +
 * verifyingContract differ.
 *
 * Source: https://developers.circle.com/stablecoins/usdc-on-test-networks
 */
export const OP_SEPOLIA_USDC =
  "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" as const;

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
