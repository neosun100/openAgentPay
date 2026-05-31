/**
 * StripePrivyEmbeddedWallet — the "managed wallet" layer.
 * ============================================================================
 *
 * Stripe Privy is a *custodial / managed* embedded-wallet service: an app
 * authenticates with an `appId` + `appSecret`, and Privy mints an EVM embedded
 * wallet whose key material is held server-side. The agent never sees a raw
 * private key in production — it calls Privy's API to sign.
 *
 * For OpenAgentPay we model that contract faithfully while staying 100% offline
 * + dependency-light:
 *   - The "managed service" is represented by `StripePrivyConfig` carrying a
 *     mock `appId` / `appSecret` (no network, no signup).
 *   - `createEmbeddedWallet()` deterministically mints a viem secp256k1 keypair
 *     as the embedded agent wallet — exactly the shape Privy returns
 *     (`{ id, address, chainType }`).
 *   - Signing happens through viem's `account.signTypedData` (real EIP-712),
 *     mirroring what Privy's signer does server-side.
 *
 * Crypto identity (key → address → signature) is fully real. Only the on-chain
 * *broadcast* needs a live RPC, kept pluggable via the connector's `submit` hook.
 *
 * @license Apache-2.0
 */

import {
  type Address,
  type Hex,
  bytesToHex,
  keccak256,
  parseSignature,
  stringToHex,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";

// ============================================================================
//  Base Sepolia chain constants (chainId 84532)
// ============================================================================

/** Base Sepolia testnet chainId. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_NETWORK = "base-sepolia";
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";

/**
 * Circle USDC on Base Sepolia (the canonical x402 test asset, 6 decimals).
 * Implements EIP-3009 transferWithAuthorization with EIP-712 domain version "2".
 */
export const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

/** Get the explorer URL for a tx hash on Base Sepolia. */
export function txExplorerUrl(txHash: string): string {
  return `${BASE_SEPOLIA_EXPLORER}/tx/${txHash.startsWith("0x") ? txHash : "0x" + txHash}`;
}

// ============================================================================
//  EIP-712 / EIP-3009 typed-data schema
// ============================================================================

/** EIP-712 typed-data schema for TransferWithAuthorization (Circle USDC shape). */
export const EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip3009Authorization {
  readonly from: Address;
  readonly to: Address;
  /** Atomic units, stringified for JSON safety. */
  readonly value: string;
  readonly validAfter: number;
  readonly validBefore: number;
  /** 32-byte hex with 0x prefix. */
  readonly nonce: Hex;
}

export interface Eip3009SignedAuthorization {
  readonly authorization: Eip3009Authorization;
  readonly signature: Hex;
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

// ============================================================================
//  Privy-shaped embedded wallet
// ============================================================================

/**
 * Mirrors the object Stripe Privy returns from `createWallet()`:
 *   { id: "<privy wallet id>", address: "0x...", chainType: "ethereum" }
 */
export interface PrivyEmbeddedWallet {
  /** Privy-side wallet id (opaque). */
  readonly id: string;
  /** The EVM address (standard 0x, 40 hex chars). */
  readonly address: Address;
  /** Privy reports "ethereum" for EVM embedded wallets. */
  readonly chainType: "ethereum";
}

export interface StripePrivyConfig {
  /** Mock Privy app id (would be a real Privy app id in production). */
  readonly appId: string;
  /** Mock Privy app secret (server-side credential; never logged/committed). */
  readonly appSecret: string;
  /**
   * Optional explicit private key for the embedded wallet (Hex, 0x-prefixed).
   * In production this never leaves Privy; here it lets tests be deterministic.
   * If omitted, a fresh random key is minted.
   */
  readonly privateKey?: Hex;
  /** Token contract the embedded wallet transacts in. Default: Base Sepolia USDC. */
  readonly tokenAddress?: Address;
  /** EIP-712 domain `name` of the token. Default: "USDC". */
  readonly tokenName?: string;
  /** EIP-712 domain `version` of the token. Default: "2" (Circle USDC). */
  readonly tokenVersion?: string;
}

/**
 * Derives a deterministic Privy wallet id from the appId + address, so the same
 * (app, wallet) pair always yields the same id — matching Privy's stable ids.
 */
function derivePrivyWalletId(appId: string, address: Address): string {
  const digest = keccak256(stringToHex(`privy:${appId}:${address.toLowerCase()}`));
  return `privy-wallet-${digest.slice(2, 26)}`;
}

/**
 * StripePrivyEmbeddedWallet — the managed-signer abstraction.
 *
 * Holds the viem account that represents the Privy embedded wallet and exposes
 * a single `signTransferAuthorization()` entry point (real EIP-712). Production
 * would replace the body with a call to Privy's signing API; the public shape
 * stays identical.
 */
export class StripePrivyEmbeddedWallet {
  readonly wallet: PrivyEmbeddedWallet;
  private readonly account: PrivateKeyAccount;
  private readonly tokenAddress: Address;
  private readonly tokenName: string;
  private readonly tokenVersion: string;

  constructor(config: StripePrivyConfig) {
    if (!config.appId) throw new Error("StripePrivy: appId is required");
    if (!config.appSecret) throw new Error("StripePrivy: appSecret is required");

    const privateKey = config.privateKey ?? generatePrivateKey();
    this.account = privateKeyToAccount(privateKey);
    this.tokenAddress = config.tokenAddress ?? BASE_SEPOLIA_USDC;
    this.tokenName = config.tokenName ?? "USDC";
    this.tokenVersion = config.tokenVersion ?? "2";
    this.wallet = {
      id: derivePrivyWalletId(config.appId, this.account.address),
      address: this.account.address,
      chainType: "ethereum",
    };
  }

  /** The embedded wallet's EVM address (0x, 40 hex). */
  get address(): Address {
    return this.account.address;
  }

  get verifyingContract(): Address {
    return this.tokenAddress;
  }

  get chainId(): number {
    return BASE_SEPOLIA_CHAIN_ID;
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization with the embedded wallet's
   * managed key. Real EIP-712 secp256k1 signature — verifiable on-chain by
   * Circle USDC's `ecrecover`. Does NOT broadcast.
   */
  async signTransferAuthorization(
    authorization: Eip3009Authorization
  ): Promise<Eip3009SignedAuthorization> {
    if (authorization.from.toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error(
        `StripePrivy: authorization.from ${authorization.from} does not match embedded wallet ${this.account.address}`
      );
    }
    const signature = await this.account.signTypedData({
      domain: {
        name: this.tokenName,
        version: this.tokenVersion,
        chainId: BigInt(BASE_SEPOLIA_CHAIN_ID),
        verifyingContract: this.tokenAddress,
      },
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    const { v, r, s } = parseSignature(signature);
    if (v === undefined) {
      throw new Error("parseSignature did not return v — unexpected for EIP-3009 sig");
    }
    return {
      authorization,
      signature,
      v: Number(v),
      r,
      s,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: this.tokenAddress,
    };
  }
}

// ============================================================================
//  Helpers
// ============================================================================

/**
 * "createEmbeddedWallet" — the Privy-style factory. Mints a managed embedded
 * wallet from a Privy app config (mock appId/appSecret). Returns the wallet
 * handle + the signer object. Mirrors `privy.walletApi.create()`.
 */
export function createEmbeddedWallet(
  config: StripePrivyConfig
): StripePrivyEmbeddedWallet {
  return new StripePrivyEmbeddedWallet(config);
}

/** Generate a fresh secp256k1 private key (delegates to viem). */
export function generateEmbeddedWalletKey(): Hex {
  return generatePrivateKey();
}

/** Random 32-byte nonce as 0x-prefixed hex (EIP-3009 replay guard). */
export function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
