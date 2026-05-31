/**
 * Linea Sepolia network configuration constants.
 *
 * Linea is a zkEVM L2 by Consensys. The testnet `lineaSepolia` (chainId 59141)
 * is a first-class viem builtin, so we re-export it rather than hand-define.
 *
 * Source: https://docs.linea.build / viem/chains
 *
 * @license Apache-2.0
 */

import type { Chain } from "viem";
import { lineaSepolia } from "viem/chains";

// ============================================================================
//  Chain definition (viem builtin re-export)
// ============================================================================

/** Linea Sepolia Testnet — chainId 59141 (viem builtin). */
export const lineaSepoliaTestnet: Chain = lineaSepolia;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * Circle USDC on Linea Sepolia (bridged test USDC, 6 decimals).
 * Implements EIP-3009 transferWithAuthorization with the same typehashes as
 * Circle USDC on Base/Ethereum, so any x402-compatible flow works unchanged
 * (only chainId + verifyingContract differ).
 *
 * Source: https://developers.circle.com/stablecoins/usdc-on-test-networks
 */
export const LINEA_SEPOLIA_USDC =
  "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7" as const;

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
