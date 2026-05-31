/**
 * Sonic Blaze testnet network configuration constants.
 *
 * Sonic (formerly Fantom Opera) is a high-throughput EVM L1 with sub-second
 * finality. Sonic Blaze is its public testnet (chainId 57054). The native gas
 * token is `S`. Any x402 / EIP-3009 flow that works against a USDC-shaped
 * ERC-20 works here unchanged — only chainId + verifyingContract differ from
 * Base Sepolia.
 *
 * We prefer viem's built-in `sonicBlazeTestnet` chain definition over a
 * hand-rolled one so RPC endpoints and explorer URLs stay in sync with the
 * viem release (rpc https://rpc.blaze.soniclabs.com,
 * explorer https://testnet.sonicscan.org).
 *
 * @license Apache-2.0
 */

import type { Address, Chain } from "viem";
import { sonicBlazeTestnet } from "viem/chains";

// ============================================================================
//  Chain definition (viem built-in)
// ============================================================================

/** Sonic Blaze testnet — chainId 57054 (viem built-in). */
export const sonicBlazeChain: Chain = sonicBlazeTestnet;

/** Numeric chainId for Sonic Blaze testnet. */
export const SONIC_BLAZE_CHAIN_ID = 57054 as const;

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC placeholder on Sonic Blaze testnet (6 decimals).
 *
 * Sonic Blaze does not (yet) have an official Circle-deployed USDC with a
 * stable published address. We use a placeholder address here so the connector
 * compiles and signs EIP-712 authorizations identically to mainnet EVM chains.
 * Override via {@link SonicConnectorConfig.tokenAddress} once a canonical
 * EIP-3009 USDC is deployed; the signing path is byte-for-byte identical.
 *
 * NOTE: balance reads / on-chain settlement against this placeholder will
 * fail until a real EIP-3009 token is wired in — offline signing + conformance
 * (which uses a stub token client) is unaffected.
 */
export const SONIC_BLAZE_USDC =
  "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" as Address;

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
