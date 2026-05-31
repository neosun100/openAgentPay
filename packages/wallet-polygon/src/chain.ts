/**
 * Polygon Amoy network configuration constants.
 *
 * We reuse viem's builtin `polygonAmoy` chain definition (chainId 80002) rather
 * than hand-rolling one — viem keeps RPC + explorer metadata current.
 *
 * Source: https://docs.polygon.technology/tools/wallets/metamask/add-polygon-network/
 *
 * @license Apache-2.0
 */

import type { Address, Chain } from "viem";
import { polygonAmoy } from "viem/chains";

// ============================================================================
//  Chain definition (viem-compatible)
// ============================================================================

/** Polygon Amoy Testnet — chainId 80002 (viem builtin). */
export const polygonAmoyTestnet: Chain = polygonAmoy;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * Circle's official testnet USDC on Polygon Amoy.
 *
 * This contract implements full EIP-3009 (transferWithAuthorization) with the
 * same typehashes as Circle USDC on every other chain, so any x402-compatible
 * flow works here unchanged (only chainId + verifyingContract differ).
 *
 * Source: https://developers.circle.com/stablecoins/usdc-on-test-networks
 */
export const POLYGON_AMOY_USDC =
  "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" as Address;

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
