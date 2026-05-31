/**
 * Mantle Sepolia network configuration constants.
 *
 * Mantle is an Ethereum L2 (originally an OP-Stack derivative, now using a
 * modular DA layer). Mantle Sepolia is its public testnet (chainId 5003).
 * Its native gas token is MNT (18 decimals), but ERC20 stablecoins such as
 * USDC behave identically to any other EVM chain — so any x402 / EIP-3009
 * (transferWithAuthorization) flow works unchanged; only chainId +
 * verifyingContract differ from other EVM chains.
 *
 * We prefer viem's built-in `mantleSepoliaTestnet` chain definition over a
 * hand-rolled one so RPC endpoints and explorer URLs stay in sync with the
 * viem release.
 *
 * @license Apache-2.0
 */

import { type Address, type Chain, defineChain } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";

// ============================================================================
//  Chain definition (viem built-in, explorer pinned to mantlescan)
// ============================================================================

/** Numeric chainId for Mantle Sepolia. */
export const MANTLE_SEPOLIA_CHAIN_ID = 5003 as const;

/** Canonical RPC endpoint for Mantle Sepolia. */
export const MANTLE_SEPOLIA_RPC_URL = "https://rpc.sepolia.mantle.xyz" as const;

/**
 * Mantle Sepolia testnet — chainId 5003. We start from viem's built-in
 * `mantleSepoliaTestnet` and pin the block explorer to mantlescan.xyz so the
 * explorer links in SettlementResult.raw match the project spec.
 */
export const mantleSepoliaChain: Chain = defineChain({
  ...mantleSepoliaTestnet,
  rpcUrls: {
    default: { http: [MANTLE_SEPOLIA_RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: "Mantle Sepolia Explorer",
      url: "https://sepolia.mantlescan.xyz",
    },
  },
});

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC on Mantle Sepolia (6 decimals). **Placeholder** address — Mantle Sepolia
 * does not (yet) host a canonical Circle EIP-3009 USDC at a stable testnet
 * address, so we use the well-known Circle USDC test address shape as a
 * placeholder. The signing path is byte-for-byte identical to other EVM chains;
 * only the on-chain `settle()` broadcast depends on the address being a real,
 * deployed EIP-3009 token. Override via `tokenAddress` in the connector config
 * once a canonical address is confirmed.
 */
export const MANTLE_SEPOLIA_USDC =
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
