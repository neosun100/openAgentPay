/**
 * Ronin Saigon network configuration constants.
 *
 * Ronin is Sky Mavis's Ethereum sidechain powering Axie Infinity. Saigon is
 * its public testnet. Per the OpenAgentPay chain spec we pin chainId **2021**
 * with RPC https://saigon-testnet.roninchain.com/rpc.
 *
 * NOTE on addresses: Ronin wallets *display* addresses with a `ronin:` prefix
 * (e.g. `ronin:abc...`), but under the hood they are bog-standard 0x EVM
 * addresses — `ronin:<hex>` ≡ `0x<hex>`. This connector works exclusively in
 * the canonical 0x form. {@link toRoninDisplay} / {@link fromRoninDisplay}
 * convert for display only; signing, recovery and RPC all use 0x.
 *
 * We hand-roll the chain definition (rather than viem's built-in `saigon`,
 * which migrated to chainId 202601) so the connector matches the spec'd
 * chainId 2021 byte-for-byte and stays deterministic regardless of viem
 * version drift.
 *
 * @license Apache-2.0
 */

import { type Address, type Chain, defineChain } from "viem";

// ============================================================================
//  Chain definition
// ============================================================================

/** Numeric chainId for Ronin Saigon testnet (per OpenAgentPay spec). */
export const RONIN_SAIGON_CHAIN_ID = 2021 as const;

/** Default RPC endpoint for Ronin Saigon. */
export const RONIN_SAIGON_RPC =
  "https://saigon-testnet.roninchain.com/rpc" as const;

/** Block explorer base URL for Ronin Saigon. */
export const RONIN_SAIGON_EXPLORER =
  "https://saigon-app.roninchain.com" as const;

/** Ronin Saigon testnet — chainId 2021, native token RON (18 decimals). */
export const roninSaigonChain: Chain = defineChain({
  id: RONIN_SAIGON_CHAIN_ID,
  name: "Ronin Saigon Testnet",
  nativeCurrency: { name: "RON", symbol: "RON", decimals: 18 },
  rpcUrls: {
    default: { http: [RONIN_SAIGON_RPC] },
  },
  blockExplorers: {
    default: { name: "Saigon Explorer", url: RONIN_SAIGON_EXPLORER },
  },
  testnet: true,
});

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * USDC on Ronin Saigon (6 decimals). Placeholder testnet address — Ronin's
 * USDC implements EIP-3009 transferWithAuthorization with the same typehashes
 * as Circle USDC, so the x402 signing path is byte-for-byte identical to other
 * EVM chains. Override via {@link RoninSaigonConnectorConfig.tokenAddress}
 * when pointing at a different deployment.
 */
export const RONIN_SAIGON_USDC =
  "0x067FBFf8990c58Ab90BaE3c97241C5d736053F77" as Address;

// ============================================================================
//  Ronin display-address helpers (cosmetic only — never used for signing)
// ============================================================================

/** Convert a canonical `0x…` address to Ronin display form `ronin:…`. */
export function toRoninDisplay(address: string): string {
  return address.startsWith("0x") ? `ronin:${address.slice(2)}` : address;
}

/** Convert a Ronin display address `ronin:…` back to canonical `0x…`. */
export function fromRoninDisplay(address: string): Address {
  return (
    address.startsWith("ronin:") ? `0x${address.slice(6)}` : address
  ) as Address;
}

// ============================================================================
//  Explorer helpers
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
