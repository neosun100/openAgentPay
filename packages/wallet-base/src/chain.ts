/**
 * Base Sepolia network configuration constants.
 *
 * Base is Coinbase's Ethereum L2 (OP Stack). Base Sepolia is its public
 * testnet (chainId 84532). Circle deploys official USDC there, so any
 * x402 / EIP-3009 flow that works against Circle USDC on Base works here
 * unchanged (only chainId + verifyingContract differ from mainnet Base).
 *
 * We prefer viem's built-in `baseSepolia` chain definition over a hand-rolled
 * one so RPC endpoints and explorer URLs stay in sync with the viem release.
 *
 * @license Apache-2.0
 */

import type { Address, Chain } from "viem";
import { baseSepolia } from "viem/chains";

// ============================================================================
//  Chain definition (viem built-in)
// ============================================================================

/** Base Sepolia testnet — chainId 84532 (viem built-in). */
export const baseSepoliaChain: Chain = baseSepolia;

/** Numeric chainId for Base Sepolia. */
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * Circle's official USDC on Base Sepolia. Implements full EIP-3009
 * (transferWithAuthorization) with the same typehashes as USDC on Ethereum,
 * so the x402 signing path is byte-for-byte identical to other EVM chains.
 *
 * Source: https://developers.circle.com/stablecoins/usdc-on-test-networks
 */
export const BASE_SEPOLIA_USDC =
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
