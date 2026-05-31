/**
 * zkSync Era Sepolia network configuration.
 *
 * We re-export viem's built-in `zksyncSepoliaTestnet` (chainId 300) so the
 * connector stays aligned with viem's canonical chain registry. A typed alias
 * (`zksyncSepolia`) keeps call sites stable even if viem renames the export.
 *
 * Source: https://docs.zksync.io / viem/chains
 *
 * @license Apache-2.0
 */

import type { Chain } from "viem";
import { zksyncSepoliaTestnet } from "viem/chains";

// ============================================================================
//  Chain definition (viem builtin)
// ============================================================================

/** zkSync Era Sepolia Testnet — chainId 300. */
export const zksyncSepolia: Chain = zksyncSepoliaTestnet;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC on zkSync Era Sepolia (6 decimals). EIP-3009 transferWithAuthorization
 * shaped like Circle USDC, so the x402 flow that works on Base Sepolia works
 * here unchanged (only chainId + verifyingContract differ).
 */
export const ZKSYNC_SEPOLIA_USDC =
  "0xAe045DE5638162fa134807Cb558E15A3F5A7F853" as const;

// ============================================================================
//  Helpers
// ============================================================================

/** Strip any trailing slash from a viem explorer base URL. */
function explorerBase(chain: Chain): string {
  const base = chain.blockExplorers?.default?.url;
  if (!base) throw new Error(`No block explorer configured for chain ${chain.id}`);
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

/** Get the explorer URL for a tx hash. */
export function txExplorerUrl(chain: Chain, txHash: string): string {
  const hash = txHash.startsWith("0x") ? txHash : "0x" + txHash;
  return `${explorerBase(chain)}/tx/${hash}`;
}

/** Get the explorer URL for an address. */
export function addressExplorerUrl(chain: Chain, address: string): string {
  return `${explorerBase(chain)}/address/${address}`;
}
