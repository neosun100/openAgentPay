/**
 * EIP-3009 token client for zkSync Era Sepolia — read balance + sign/broadcast
 * transferWithAuthorization. Ported from `wallet-hashkey/src/token-client.ts`.
 *
 *   1. Off-chain EIP-712 sign (no broadcast yet)
 *   2. Facilitator wallet broadcasts the signed authorization on-chain
 *   3. Token contract verifies the signature and atomically transfers
 *
 * @license Apache-2.0
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { zksyncSepolia } from "./chain.js";

// ============================================================================
//  Constants — EIP-3009 standard
// ============================================================================

/** Minimal ABI subset of an EIP-3009 ERC20 (USDC-shaped). */
export const EIP3009_USDC_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** EIP-712 typed-data schema for TransferWithAuthorization. */
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

// ============================================================================
//  Types
// ============================================================================

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
  /** The token's chainId (300 for zkSync Era Sepolia). */
  readonly chainId: number;
  /** The token contract address the signature is bound to. */
  readonly verifyingContract: Address;
}

export interface ZkSyncTokenClientConfig {
  readonly tokenAddress: Address;
  readonly chain?: typeof zksyncSepolia;
  readonly rpcUrl?: string;
  /** Optional override for the underlying PublicClient (used in tests). */
  readonly publicClient?: PublicClient;
}

// ============================================================================
//  Client
// ============================================================================

export class ZkSyncTokenClient {
  public readonly chain: typeof zksyncSepolia;
  public readonly tokenAddress: Address;
  public readonly publicClient: PublicClient;

  constructor(config: ZkSyncTokenClientConfig) {
    this.chain = config.chain ?? zksyncSepolia;
    this.tokenAddress = config.tokenAddress;
    this.publicClient =
      config.publicClient ??
      createPublicClient({
        chain: this.chain,
        transport: http(config.rpcUrl ?? this.chain.rpcUrls.default.http[0]),
      });
  }

  // ---- Reads --------------------------------------------------------------

  async getDecimals(): Promise<number> {
    const r = await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_USDC_ABI,
      functionName: "decimals",
    });
    return Number(r);
  }

  async getName(): Promise<string> {
    return await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_USDC_ABI,
      functionName: "name",
    });
  }

  async getBalance(owner: Address): Promise<bigint> {
    return await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_USDC_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  async getDomainSeparator(): Promise<Hex> {
    return await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_USDC_ABI,
      functionName: "DOMAIN_SEPARATOR",
    });
  }

  async isAuthorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
    return await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_USDC_ABI,
      functionName: "authorizationState",
      args: [authorizer, nonce],
    });
  }

  // ---- Signing (off-chain, no broadcast) ----------------------------------

  async signTransferAuthorization(
    signer: PrivateKeyAccount,
    authorization: Eip3009Authorization
  ): Promise<Eip3009SignedAuthorization> {
    if (signer.address.toLowerCase() !== authorization.from.toLowerCase()) {
      throw new Error(
        `Signer address ${signer.address} does not match authorization.from ${authorization.from}`
      );
    }
    const name = await this.getName();
    const signature = await signer.signTypedData({
      domain: {
        name,
        version: "2",
        chainId: BigInt(this.chain.id),
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
      throw new Error("parseSignature did not return v — should not happen for legacy signatures");
    }
    return {
      authorization,
      signature,
      v: Number(v),
      r,
      s,
      chainId: this.chain.id,
      verifyingContract: this.tokenAddress,
    };
  }

  // ---- Broadcast (settle) -------------------------------------------------

  async broadcastSignedAuthorization(
    facilitator: WalletClient,
    signed: Eip3009SignedAuthorization
  ): Promise<Hex> {
    if (signed.chainId !== this.chain.id) {
      throw new Error(
        `Signed authorization chainId ${signed.chainId} does not match client chainId ${this.chain.id}`
      );
    }
    const { authorization, v, r, s } = signed;
    const account = facilitator.account;
    if (!account) throw new Error("WalletClient must have an account configured");
    const txHash = await facilitator.writeContract({
      account,
      address: this.tokenAddress,
      abi: EIP3009_USDC_ABI,
      functionName: "transferWithAuthorization",
      chain: this.chain,
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        v,
        r,
        s,
      ],
    });
    return txHash;
  }

  async waitForReceipt(
    txHash: Hex
  ): Promise<{ blockNumber: bigint; gasUsed: bigint; status: "success" | "reverted" }> {
    const r = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { blockNumber: r.blockNumber, gasUsed: r.gasUsed, status: r.status };
  }
}

// ============================================================================
//  Helpers
// ============================================================================

/** Random 32-byte nonce as hex string (0x-prefixed). */
export function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Construct a viem WalletClient from a private key + chain. */
export function createWalletClientFromPrivateKey(
  privateKey: Hex,
  chain: typeof zksyncSepolia,
  rpcUrl?: string
): { wallet: WalletClient; account: PrivateKeyAccount } {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl ?? chain.rpcUrls.default.http[0]),
  });
  return { wallet, account };
}
