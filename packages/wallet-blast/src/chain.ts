/**
 * Blast Sepolia network configuration constants.
 *
 * Blast is an Ethereum L2 (OP Stack derivative with native yield). Blast
 * Sepolia is its public testnet (chainId 168587773). The x402 / EIP-3009
 * signing path is byte-for-byte identical to other EVM chains — only chainId
 * + verifyingContract differ.
 *
 * We prefer viem's built-in `blastSepolia` chain definition over a hand-rolled
 * one so RPC endpoints and explorer URLs stay in sync with the viem release.
 *
 * @license Apache-2.0
 */

import type { Address, Chain } from "viem";
import { blastSepolia } from "viem/chains";

// ============================================================================
//  Chain definition (viem built-in)
// ============================================================================

/** Blast Sepolia testnet — chainId 168587773 (viem built-in). */
export const blastSepoliaChain: Chain = blastSepolia;

/** Numeric chainId for Blast Sepolia. */
export const BLAST_SEPOLIA_CHAIN_ID = 168587773 as const;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC placeholder on Blast Sepolia. Blast Sepolia does not yet host an
 * official Circle USDC deployment, so this is a placeholder address that any
 * EIP-3009-compatible test token can override via the connector config
 * (`tokenAddress`). The signing path is identical regardless of the contract.
 *
 * Override with a real EIP-3009 token address for LIVE settlement tests.
 */
export const BLAST_SEPOLIA_USDC =
  "0x4300000000000000000000000000000000000003" as Address;

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
