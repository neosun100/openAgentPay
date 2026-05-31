/**
 * EIP-3009 token client for Berachain mainnet — read balance + build / sign /
 * submit transferWithAuthorization.
 *
 * Same three-step flow as the wallet-base reference impl:
 *   1. Off-chain EIP-712 sign (no broadcast yet)
 *   2. Facilitator wallet broadcasts the signed authorization on-chain
 *   3. Token contract verifies the signature and atomically transfers
 *
 * Compatible with any ERC20 implementing EIP-3009, including the HONEY/USDC
 * stablecoin used as the default asset for this connector.
 *
 * @license Apache-2.0
 */

import {
  type Address,
  type Chain,
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

import { berachainMainnet } from "./chain.js";

// ============================================================================
//  Constants — EIP-3009 standard
// ============================================================================

/** Minimal ABI subset of an EIP-3009 ERC20 (USDC-shaped). */
export const EIP3009_USDC_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
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
  /** The token's chainId (80094 for Berachain mainnet). */
  readonly chainId: number;
  /** The token contract address that the signature is bound to. */
  readonly verifyingContract: Address;
}

export interface BeraTokenClientConfig {
  /** Token contract (e.g. HONEY/USDC stablecoin on Berachain mainnet). */
  readonly tokenAddress: Address;
  /** Chain to operate on. Default: Berachain mainnet. */
  readonly chain?: Chain;
  /** Optional override for RPC URL. */
  readonly rpcUrl?: string;
  /** Optional override for the underlying PublicClient (used in tests). */
  readonly publicClient?: PublicClient;
  /**
   * EIP-712 domain `version` string for the token. USDC-shaped tokens use "2".
   * Override only if pointing at a token that declares a different version.
   */
  readonly domainVersion?: string;
}

// ============================================================================
//  Client
// ============================================================================

/**
 * Stateless client for reading EIP-3009 token state and signing / submitting
 * transferWithAuthorization on Berachain mainnet.
 */
export class BeraTokenClient {
  public readonly chain: Chain;
  public readonly tokenAddress: Address;
  public readonly publicClient: PublicClient;
  private readonly domainVersion: string;

  constructor(config: BeraTokenClientConfig) {
    this.chain = config.chain ?? berachainMainnet;
    this.tokenAddress = config.tokenAddress;
    this.domainVersion = config.domainVersion ?? "2";
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

  /**
   * Sign an EIP-3009 transferWithAuthorization off-chain.
   * Returns the signed payload ready for {@link broadcastSignedAuthorization}.
   *
   * The signer address MUST match `authorization.from`, otherwise the on-chain
   * `ecrecover` will reject the signature.
   *
   * `tokenName` may be passed to avoid a network round-trip for the EIP-712
   * domain `name` (used in offline conformance signing).
   */
  async signTransferAuthorization(
    signer: PrivateKeyAccount,
    authorization: Eip3009Authorization,
    tokenName?: string
  ): Promise<Eip3009SignedAuthorization> {
    if (signer.address.toLowerCase() !== authorization.from.toLowerCase()) {
      throw new Error(
        `Signer address ${signer.address} does not match authorization.from ${authorization.from}`
      );
    }
    const name = tokenName ?? (await this.getName());
    const signature = await signer.signTypedData({
      domain: {
        name,
        version: this.domainVersion,
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

  /**
   * Submit a signed authorization on-chain. Any wallet can broadcast — the
   * tx sender (gas payer) is **not** required to be authorization.from.
   *
   * Returns the tx hash. Use {@link waitForReceipt} to wait for confirmation.
   */
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

  /** Wait for a tx to be mined and verify it succeeded. */
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
  chain: Chain,
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
