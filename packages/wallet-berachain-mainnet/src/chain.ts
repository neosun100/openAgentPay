/**
 * Berachain mainnet network configuration constants.
 *
 * Berachain is a high-performance EVM-identical L1 built on the Cosmos SDK
 * with Proof-of-Liquidity consensus. Its mainnet (chainId 80094) launched in
 * 2025 and is fully EVM-equivalent, so any x402 / EIP-3009
 * (transferWithAuthorization) flow that works against an EIP-3009 ERC20 on
 * Ethereum works here unchanged (only chainId + verifyingContract differ).
 *
 * viem ships a `berachain` chain in recent releases, but to keep this
 * connector self-contained and pinned to the exact RPC/explorer we want, we
 * hand-define the chain object here (matches the structure viem expects).
 *
 * @license Apache-2.0
 */

import type { Address, Chain } from "viem";

// ============================================================================
//  Chain definition (hand-defined)
// ============================================================================

/** Numeric chainId for Berachain mainnet. */
export const BERACHAIN_MAINNET_CHAIN_ID = 80094 as const;

/**
 * Berachain mainnet — chainId 80094. Hand-defined so RPC + explorer stay
 * pinned regardless of the installed viem version.
 *
 * - RPC:      https://rpc.berachain.com
 * - Explorer: https://berascan.com
 * - Native:   BERA (18 decimals)
 */
export const berachainMainnet: Chain = {
  id: BERACHAIN_MAINNET_CHAIN_ID,
  name: "Berachain",
  nativeCurrency: { name: "BERA", symbol: "BERA", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.berachain.com"] },
    public: { http: ["https://rpc.berachain.com"] },
  },
  blockExplorers: {
    default: { name: "Berascan", url: "https://berascan.com" },
  },
  testnet: false,
};

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * Stablecoin used as the default x402 settlement asset on Berachain mainnet.
 *
 * NOTE: this is a 6-decimal HONEY/USDC stablecoin **placeholder**. Berachain's
 * canonical USDC (bridged) and the native HONEY overcollateralized stablecoin
 * have distinct addresses; this connector defaults to a placeholder so the
 * signing path is exercised end-to-end. Override `tokenAddress` in the
 * connector config to point at the real on-chain token before live use.
 *
 * The EIP-712 typehashes are identical to USDC on Ethereum, so the x402
 * signing path is byte-for-byte the same across EVM chains.
 */
export const BERACHAIN_MAINNET_STABLE =
  "0x549943e04f40284185054145c6E4e9568C1D3241" as Address;

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
