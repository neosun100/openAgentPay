/**
 * Berachain bArtio network configuration constants.
 *
 * Berachain is an EVM-identical L1 built on the Polaris/BeaconKit stack with a
 * novel Proof-of-Liquidity consensus. bArtio is its public testnet
 * (chainId 80084). Because the execution layer is byte-for-byte EVM-compatible,
 * any x402 / EIP-3009 (transferWithAuthorization) flow that works against an
 * EIP-3009 ERC20 on Ethereum works here unchanged — only chainId +
 * verifyingContract differ.
 *
 * viem does not (reliably) ship a built-in `berachainTestnetbArtio` chain
 * definition, so we hand-define it here using viem's `defineChain` helper.
 *
 * @license Apache-2.0
 */

import { type Address, type Chain, defineChain } from "viem";

// ============================================================================
//  Chain definition (hand-rolled — viem may lack bArtio)
// ============================================================================

/** Numeric chainId for Berachain bArtio testnet. */
export const BERACHAIN_BARTIO_CHAIN_ID = 80084 as const;

/**
 * Berachain bArtio testnet — chainId 80084.
 *
 * Hand-defined because viem's built-in chain registry does not consistently
 * include bArtio across versions. Pinning it here keeps RPC + explorer URLs
 * stable regardless of the installed viem release.
 */
export const berachainBartioChain: Chain = defineChain({
  id: BERACHAIN_BARTIO_CHAIN_ID,
  name: "Berachain bArtio",
  nativeCurrency: { name: "BERA", symbol: "BERA", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://bartio.rpc.berachain.com"] },
    public: { http: ["https://bartio.rpc.berachain.com"] },
  },
  blockExplorers: {
    default: { name: "Beratrail", url: "https://bartio.beratrail.io" },
  },
  testnet: true,
});

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC-style stablecoin on Berachain bArtio (6 decimals).
 *
 * NOTE: This is a placeholder testnet address. Berachain bArtio's canonical
 * USDC / HONEY-pegged stablecoin address should be substituted once the
 * project pins the official deployment. The connector accepts a
 * `tokenAddress` override so a real address can be wired without code changes.
 *
 * The token is expected to implement full EIP-3009
 * (transferWithAuthorization) with the same typehashes as Circle USDC, so the
 * x402 signing path is identical to every other EVM chain in the monorepo.
 */
export const BERACHAIN_BARTIO_USDC =
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
