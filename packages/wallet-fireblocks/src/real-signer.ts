/**
 * RealFireblocksSigner — institutional MPC-custody signer modeled on
 * Fireblocks, backed by viem secp256k1 + @noble/hashes.
 * ============================================================================
 *
 * Fireblocks is an institutional digital-asset custody platform. Its defining
 * property is **MPC-CMP key management**: the private key for a vault account
 * never exists in one place — it's sharded across the Fireblocks co-signer
 * cluster and the customer's signing devices. There is no single "private key"
 * a developer can export; transactions are authorized through the Fireblocks
 * API (apiKey + RSA-signed JWT) and gated by the on-platform **Policy Engine**
 * (TAP — Transaction Authorization Policy).
 *
 * What's REAL here (offline, zero network, zero signups):
 *   - A real secp256k1 keypair → real 0x EVM address. In production this
 *     address is the deposit address of a Fireblocks **vault account asset**
 *     (BASE_SEPOLIA_USDC under the EVM vault); the underlying key is MPC-
 *     sharded and never materialized. For OpenAgentPay's offline-first posture
 *     we hold a viem keypair as the documented **demo stand-in** for the MPC
 *     signing identity — the cryptographic shape (key → address → EIP-712 sig)
 *     is identical to what Fireblocks' raw-signing API would return.
 *   - A real EIP-712 signature over an EIP-3009 `transferWithAuthorization`
 *     (USDC, FiatTokenV2 domain) — verifiable against the vault address.
 *
 * What's pluggable (production wires the Fireblocks SDK):
 *   - `submit` hook → in production, create a Fireblocks transaction
 *     (CONTRACT_CALL `transferWithAuthorization`, or a native transfer) via the
 *     API; the Policy Engine evaluates it, MPC co-signs, and we get a real
 *     Fireblocks transaction id + on-chain tx hash. Offline default returns a
 *     deterministic mock Fireblocks tx id, no network.
 *
 * @license Apache-2.0
 */

import { sha256 } from "@noble/hashes/sha2";
import {
  type Address,
  type Hex,
  bytesToHex,
  parseSignature,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";

// ============================================================================
//  Constants — Base Sepolia + USDC
// ============================================================================

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** USDC on Base Sepolia (Circle's official testnet USDC). */
export const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

export const BASE_SEPOLIA_EXPLORER_TX =
  "https://sepolia.basescan.org/tx/";

// ============================================================================
//  EIP-712 typed-data schema for EIP-3009 TransferWithAuthorization
// ============================================================================

export const EIP712_TRANSFER_WITH_AUTHORIZATION_TYPES = {
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
//  Keypair helpers (MPC stand-in)
// ============================================================================

export interface FireblocksKeypair {
  /**
   * secp256k1 private key (Hex, 0x-prefixed). In a real Fireblocks vault this
   * does NOT exist as a single value — it is MPC-sharded. Here it is the demo
   * stand-in for the vault asset's signing identity.
   */
  readonly privateKey: Hex;
  /** Vault asset deposit address (0x…40-hex EVM address). */
  readonly address: Address;
}

/** Generate a fresh, cryptographically-random vault signing identity (secp256k1). */
export function generateFireblocksKeypair(): FireblocksKeypair {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

/** Reconstruct a vault signing identity from an existing secp256k1 private key. */
export function keypairFromPrivateKey(privateKey: Hex): FireblocksKeypair {
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

/**
 * Deterministically derive a vault signing identity from a seed + vaultAccountId.
 *
 * Mirrors Fireblocks' "one key per vault account asset" determinism: the same
 * (seed, vaultAccountId) always resolves to the same vault address. Useful for
 * reproducible tests/demos without random keygen.
 *
 *   privKey = SHA-256( "fireblocks-vault/v1\0" || seed || "\0" || vaultAccountId )
 *
 * The result is a valid secp256k1 key in [1, n-1] (re-hashes the ~1/2^128
 * degenerate cases).
 */
export function deriveFireblocksKeypair(
  seed: string,
  vaultAccountId: string
): FireblocksKeypair {
  const enc = new TextEncoder();
  const N =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  let material: Uint8Array = Uint8Array.from(
    enc.encode(`fireblocks-vault/v1\0${seed}\0${vaultAccountId}`)
  );
  for (let i = 0; i < 8; i++) {
    const digest = sha256(material);
    const asBig = BigInt(bytesToHex(digest));
    if (asBig >= 1n && asBig < N) {
      const priv = bytesToHex(digest);
      const account = privateKeyToAccount(priv);
      return { privateKey: priv, address: account.address };
    }
    material = Uint8Array.from(digest);
  }
  throw new Error("deriveFireblocksKeypair: failed to derive a valid key");
}

// ============================================================================
//  EIP-3009 authorization shapes
// ============================================================================

export interface Eip3009Authorization {
  readonly from: Address;
  readonly to: Address;
  /** Atomic units (USDC has 6 decimals), stringified for JSON safety. */
  readonly value: string;
  readonly validAfter: number;
  readonly validBefore: number;
  /** 32-byte hex, 0x-prefixed. */
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
  /** USDC EIP-712 domain name used (for verification + audit). */
  readonly domainName: string;
}

// ============================================================================
//  Settlement hook shapes
// ============================================================================

export interface FireblocksSubmitInput {
  readonly signed: Eip3009SignedAuthorization;
  /** Fireblocks vault account the transaction originates from. */
  readonly vaultAccountId: string;
  /** Whether the Policy Engine (TAP) auto-approved (no manual quorum). */
  readonly policyAutoApproved: boolean;
}

export interface FireblocksSubmitResult {
  /** Fireblocks transaction id (UUID in prod). */
  readonly fireblocksTxId: string;
  /** On-chain tx hash once mined (optional). */
  readonly txHash?: string;
  readonly raw?: unknown;
}

// ============================================================================
//  RealFireblocksSigner
// ============================================================================

export interface RealFireblocksSignerConfig {
  /**
   * Existing vault signing-identity private key. If omitted, a fresh one is
   * generated (random vault). In real Fireblocks this is MPC-sharded.
   */
  readonly privateKey?: Hex;
  /** Fireblocks vault account id (e.g., "0" / "12"). Surfaced in metadata. */
  readonly vaultAccountId?: string;
  /** Mock Fireblocks API key — demo stand-in, never used to sign offline. */
  readonly apiKey?: string;
  /** Chain id (default Base Sepolia 84532). */
  readonly chainId?: number;
  /** USDC token contract override (default Base Sepolia USDC). */
  readonly tokenAddress?: Address;
  /** USDC EIP-712 domain name. Circle USDC uses "USD Coin". */
  readonly usdcDomainName?: string;
  /** USDC EIP-712 domain version. Circle USDC (FiatTokenV2) uses "2". */
  readonly usdcDomainVersion?: string;
  /**
   * Whether the Policy Engine auto-approves (no manual quorum). Modeled as
   * `requiresUserApproval:false` at the capability layer. Default true.
   */
  readonly policyAutoApproved?: boolean;
  /**
   * Optional balance reader — wired to a Base Sepolia RPC (USDC balanceOf) or
   * the Fireblocks balances API in prod. Offline default returns 0n.
   */
  readonly balanceReader?: (address: Address) => Promise<bigint>;
  /**
   * Optional submit hook — wired to the Fireblocks SDK
   * (createTransaction → policy eval → MPC co-sign) in production. Offline
   * default returns a deterministic mock Fireblocks tx id.
   */
  readonly submit?: (input: FireblocksSubmitInput) => Promise<FireblocksSubmitResult>;
}

export class RealFireblocksSigner {
  /** Vault asset deposit address — the on-chain handle / publicHandle. */
  readonly address: Address;
  readonly vaultAccountId: string;
  readonly chainId: number;
  readonly tokenAddress: Address;
  readonly policyAutoApproved: boolean;

  private readonly account: PrivateKeyAccount;
  private readonly cfg: RealFireblocksSignerConfig;
  private readonly domainName: string;
  private readonly domainVersion: string;

  constructor(cfg: RealFireblocksSignerConfig = {}) {
    const key = cfg.privateKey ?? generatePrivateKey();
    this.account = privateKeyToAccount(key);
    this.address = this.account.address;
    this.vaultAccountId = cfg.vaultAccountId ?? "0";
    this.chainId = cfg.chainId ?? BASE_SEPOLIA_CHAIN_ID;
    this.tokenAddress = cfg.tokenAddress ?? BASE_SEPOLIA_USDC;
    this.policyAutoApproved = cfg.policyAutoApproved ?? true;
    this.domainName = cfg.usdcDomainName ?? "USD Coin";
    this.domainVersion = cfg.usdcDomainVersion ?? "2";
    this.cfg = cfg;
  }

  /**
   * Produce a real EIP-712 signature over an EIP-3009
   * transferWithAuthorization. No chain I/O — pure offline signing.
   * The signer address MUST equal authorization.from (the vault address).
   */
  async signTransferAuthorization(
    authorization: Eip3009Authorization
  ): Promise<Eip3009SignedAuthorization> {
    if (
      this.account.address.toLowerCase() !== authorization.from.toLowerCase()
    ) {
      throw new Error(
        `Fireblocks vault ${this.account.address} does not match authorization.from ${authorization.from}`
      );
    }
    const signature = await this.account.signTypedData({
      domain: {
        name: this.domainName,
        version: this.domainVersion,
        chainId: BigInt(this.chainId),
        verifyingContract: this.tokenAddress,
      },
      types: EIP712_TRANSFER_WITH_AUTHORIZATION_TYPES,
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
      throw new Error("parseSignature returned no v");
    }
    return {
      authorization,
      signature,
      v: Number(v),
      r,
      s,
      chainId: this.chainId,
      verifyingContract: this.tokenAddress,
      domainName: this.domainName,
    };
  }

  /**
   * Submit a signed authorization. Production wires `submit` to the Fireblocks
   * SDK (policy-gated MPC co-sign); offline returns a deterministic mock
   * Fireblocks transaction id.
   */
  async submitTransaction(
    signed: Eip3009SignedAuthorization
  ): Promise<FireblocksSubmitResult> {
    if (this.cfg.submit) {
      return this.cfg.submit({
        signed,
        vaultAccountId: this.vaultAccountId,
        policyAutoApproved: this.policyAutoApproved,
      });
    }
    // Offline-safe: deterministic mock Fireblocks tx id derived from the sig.
    // Real Fireblocks ids are UUIDs; we shape one from the signature digest.
    const digest = sha256(new TextEncoder().encode(signed.signature));
    const hex = bytesToHex(digest).slice(2);
    const mockTxId = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
    return {
      fireblocksTxId: mockTxId,
      raw: { mock: true, policyAutoApproved: this.policyAutoApproved },
    };
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address);
    }
    return 0n;
  }

  /**
   * Verify an EIP-3009 signature against the vault address — for tests + audits.
   * Returns false for any tampered authorization.
   */
  async verify(signed: Eip3009SignedAuthorization): Promise<boolean> {
    try {
      const { verifyTypedData } = await import("viem");
      return await verifyTypedData({
        address: this.account.address,
        domain: {
          name: signed.domainName,
          version: this.domainVersion,
          chainId: BigInt(signed.chainId),
          verifyingContract: signed.verifyingContract,
        },
        types: EIP712_TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: signed.authorization.from,
          to: signed.authorization.to,
          value: BigInt(signed.authorization.value),
          validAfter: BigInt(signed.authorization.validAfter),
          validBefore: BigInt(signed.authorization.validBefore),
          nonce: signed.authorization.nonce,
        },
        signature: signed.signature,
      });
    } catch {
      return false;
    }
  }

  get signerAddress(): Address {
    return this.address;
  }
}

// ============================================================================
//  Helpers
// ============================================================================

/** Random 32-byte nonce, 0x-prefixed hex (EIP-3009 replay protection). */
export function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Normalize an arbitrary nonce string to a 32-byte 0x-hex value. */
export function ensureHex32(s: string): Hex {
  let v = s.startsWith("0x") ? s : "0x" + s;
  if (v.length < 66) {
    v = "0x" + v.slice(2).padStart(64, "0");
  } else if (v.length > 66) {
    v = "0x" + v.slice(2).slice(0, 64);
  }
  return v as Hex;
}
