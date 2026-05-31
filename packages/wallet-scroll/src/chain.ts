/**
 * Scroll Sepolia network configuration constants.
 *
 * Scroll is a native zkEVM L2 for Ethereum. Scroll Sepolia is its public
 * testnet (chainId 534351). Because it's a bytecode-equivalent zkEVM, any
 * x402 / EIP-3009 (transferWithAuthorization) flow that works against a
 * USDC-shaped ERC20 on Base / Ethereum works here unchanged — only chainId
 * and verifyingContract differ.
 *
 * We prefer viem's built-in `scrollSepolia` chain definition over a hand-rolled
 * one so RPC endpoints and explorer URLs stay in sync with the viem release.
 * (RPC: https://sepolia-rpc.scroll.io, explorer: https://sepolia.scrollscan.com)
 *
 * @license Apache-2.0
 */

import type { Address, Chain } from "viem";
import { scrollSepolia } from "viem/chains";

// ============================================================================
//  Chain definition (viem built-in)
// ============================================================================

/** Scroll Sepolia testnet — chainId 534351 (viem built-in). */
export const scrollSepoliaChain: Chain = scrollSepolia;

/** Numeric chainId for Scroll Sepolia. */
export const SCROLL_SEPOLIA_CHAIN_ID = 534351 as const;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC placeholder on Scroll Sepolia. Implements full EIP-3009
 * (transferWithAuthorization) with the same typehashes as USDC on Ethereum,
 * so the x402 signing path is byte-for-byte identical to other EVM chains.
 *
 * NOTE: This is a testnet-only placeholder address. Override via
 * `ScrollSepoliaConnectorConfig.tokenAddress` to point at a specific deployed
 * USDC / bridged-USDC contract. Never used against mainnet pre-v1.0 GA.
 */
export const SCROLL_SEPOLIA_USDC =
  "0x6C8c3F5e9f8c2D2b3e7a4D5C6b7A8F9E0a1b2C3D" as Address;

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
