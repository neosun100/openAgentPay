/**
 * RealCircleSigner — secp256k1 EVM signer modeling Circle's
 * "developer-controlled wallet" key custody, backed by viem + @noble/hashes.
 * ============================================================================
 *
 * Circle Programmable Wallets (developer-controlled mode):
 *   - The developer holds an `entitySecret` (a 32-byte secret) registered with
 *     Circle. Circle derives + custodies per-user wallet keys server-side.
 *   - For OpenAgentPay's offline-first, no-signup posture we MIRROR that model
 *     deterministically: the connector derives the agent wallet's EVM keypair
 *     IN-PROCESS from (entitySecret, userId/walletSetId) via SHA-256.
 *   - This yields a real secp256k1 keypair → real 0x address → real EIP-712
 *     signature, identical in shape to what Circle's API would return, with
 *     zero network calls and zero signups.
 *
 * Why not call the Circle API?
 *   - Conformance + unit tests must run offline with zero credentials.
 *   - The cryptographic identity (key → address → EIP-712 sig) is fully real
 *     here; only the on-chain *broadcast* needs a facilitator. We keep that
 *     pluggable via the optional `submit` hook so a production deployment can
 *     wire Circle's `developer/transactions/transfer` (gas-station sponsored)
 *     without changing this file.
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
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { resolveCircleChain, type CircleNetwork } from "./chain.js";

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
//  Keypair derivation (developer-controlled model)
// ============================================================================

export interface CircleKeypair {
  /** 32-byte secp256k1 private key (Hex, 0x-prefixed). */
  readonly privateKey: Hex;
  /** Checksummed EVM address — the agent wallet's on-chain handle. */
  readonly address: Address;
}

/**
 * Deterministically derive an EVM keypair from Circle's entitySecret + a
 * per-wallet salt (walletSetId / userId). This emulates Circle's server-side
 * key derivation: the same (entitySecret, salt) always yields the same wallet.
 *
 *   privKey = SHA-256( "circle-pw/v1\0" || entitySecret || "\0" || salt )
 *
 * The result is a real, valid secp256k1 key (we reject the astronomically
 * unlikely all-zero / >= curve-order edge cases by re-hashing).
 */
export function deriveCircleKeypair(
  entitySecret: string,
  salt: string
): CircleKeypair {
  const enc = new TextEncoder();
  // secp256k1 order n — derived key must be in [1, n-1].
  const N =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  // Seed material as a plain Uint8Array (decouples from TextEncoder's buffer type).
  let material: Uint8Array = Uint8Array.from(
    enc.encode(`circle-pw/v1\0${entitySecret}\0${salt}`)
  );
  // Loop is effectively single-pass; guards the ~1/2^128 degenerate cases.
  for (let i = 0; i < 8; i++) {
    const digest = sha256(material);
    const asBig = BigInt(bytesToHex(digest));
    if (asBig >= 1n && asBig < N) {
      const priv = bytesToHex(digest);
      const account = privateKeyToAccount(priv);
      return { privateKey: priv, address: account.address };
    }
    material = Uint8Array.from(digest); // re-hash and retry
  }
  throw new Error("deriveCircleKeypair: failed to derive a valid key");
}

/** Generate a fresh random entitySecret (32-byte hex, no 0x) for demos/tests. */
export function generateEntitySecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
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
//  RealCircleSigner
// ============================================================================

export interface CircleBroadcastInput {
  readonly signed: Eip3009SignedAuthorization;
  readonly network: CircleNetwork;
  /** Whether the gas-station sponsored the gas (Circle feature). */
  readonly gasStation: boolean;
}

export interface CircleBroadcastResult {
  readonly transactionHash: string;
  readonly explorerUrl?: string;
  readonly raw?: unknown;
}

export interface RealCircleSignerConfig {
  /** Circle entity secret (32-byte hex). Required for key derivation. */
  readonly entitySecret: string;
  /** Salt for per-wallet derivation — typically a walletSetId or userId. */
  readonly walletSalt: string;
  /** Which testnet this signer is bound to. */
  readonly network: CircleNetwork;
  /**
   * USDC EIP-712 domain version. Circle USDC uses "2" (FiatTokenV2). Override
   * only if a particular deployment differs.
   */
  readonly usdcDomainVersion?: string;
  /** USDC EIP-712 domain name. Circle USDC uses "USD Coin". */
  readonly usdcDomainName?: string;
  /**
   * Optional balance reader — wired to a Circle balances API / RPC in prod.
   * Omitted → getBalance() returns 0 (offline-safe).
   */
  readonly balanceReader?: (address: Address) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to Circle's gas-station-sponsored
   * `transferWithAuthorization` submit in production. If omitted,
   * settle() returns a DETERMINISTIC mock tx hash derived from the signature
   * (offline-safe, reproducible).
   */
  readonly submit?: (input: CircleBroadcastInput) => Promise<CircleBroadcastResult>;
}

export class RealCircleSigner {
  readonly address: Address;
  readonly network: CircleNetwork;
  private readonly account: PrivateKeyAccount;
  private readonly cfg: RealCircleSignerConfig;
  private readonly domainName: string;
  private readonly domainVersion: string;

  constructor(cfg: RealCircleSignerConfig) {
    if (!cfg.entitySecret) {
      throw new Error("RealCircleSigner: entitySecret is required");
    }
    const kp = deriveCircleKeypair(cfg.entitySecret, cfg.walletSalt);
    this.account = privateKeyToAccount(kp.privateKey);
    this.address = this.account.address;
    this.network = cfg.network;
    this.cfg = cfg;
    this.domainName = cfg.usdcDomainName ?? "USD Coin";
    this.domainVersion = cfg.usdcDomainVersion ?? "2";
  }

  /**
   * Produce a real EIP-712 signature over an EIP-3009
   * transferWithAuthorization. No chain I/O — pure offline signing.
   * The signer address MUST equal authorization.from.
   */
  async signTransferAuthorization(
    authorization: Eip3009Authorization
  ): Promise<Eip3009SignedAuthorization> {
    if (
      this.account.address.toLowerCase() !== authorization.from.toLowerCase()
    ) {
      throw new Error(
        `Signer ${this.account.address} does not match authorization.from ${authorization.from}`
      );
    }
    const info = resolveCircleChain(this.network);
    const signature = await this.account.signTypedData({
      domain: {
        name: this.domainName,
        version: this.domainVersion,
        chainId: BigInt(info.chain.id),
        verifyingContract: info.usdc,
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
      chainId: info.chain.id,
      verifyingContract: info.usdc,
      domainName: this.domainName,
    };
  }

  /**
   * Broadcast a signed authorization. Production wires `submit` to Circle's
   * gas-station-sponsored transfer; offline returns a deterministic mock hash.
   */
  async broadcast(
    signed: Eip3009SignedAuthorization,
    gasStation: boolean
  ): Promise<CircleBroadcastResult> {
    if (this.cfg.submit) {
      return this.cfg.submit({ signed, network: this.network, gasStation });
    }
    // Offline-safe: deterministic mock tx hash = keccak-shaped SHA-256 of sig.
    const digest = sha256(new TextEncoder().encode(signed.signature));
    const mockHash = bytesToHex(digest); // 0x + 64 hex = 32-byte tx-hash shape
    return {
      transactionHash: mockHash,
      explorerUrl: `${resolveCircleChain(this.network).explorerTxBase}${mockHash}`,
      raw: { mock: true, gasStation },
    };
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address);
    }
    return 0n;
  }

  /** Re-derive the signing account's address (pure). */
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
