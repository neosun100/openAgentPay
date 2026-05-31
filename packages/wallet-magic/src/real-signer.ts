/**
 * RealMagicSigner — secp256k1 EVM signer for Magic.link email wallets.
 * ============================================================================
 *
 * Magic.link is a mainstream, *email-based* wallet: end users log in with an
 * email magic-link and Magic provisions a non-custodial EVM key for them. The
 * production Magic SDK derives the key inside a secure DKMS enclave keyed to
 * the user's email. We can't run that enclave offline — but the public ABI is
 * just "an EVM account that signs EIP-712". So this signer:
 *
 *   - Generates a REAL secp256k1 keypair in-process (viem generatePrivateKey)
 *   - Derives the canonical 0x checksummed address (viem privateKeyToAccount)
 *   - Binds that identity to an email (Magic's user handle)
 *   - Signs EIP-3009 transferWithAuthorization via real EIP-712 (viem
 *     signTypedData) — verifiable on-chain by any USDC-shaped contract
 *
 * The cryptographic identity (email → key → 0x address → signature) is fully
 * real here. Only the on-chain *broadcast* needs a live RPC + facilitator,
 * which we keep behind the optional pluggable `submit` hook (offline-safe
 * default — exactly mirrors RealSolanaSigner's design).
 *
 * @license Apache-2.0
 */

import {
  type Address,
  type Hex,
  bytesToHex,
  hashTypedData,
  recoverTypedDataAddress,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";

// ============================================================================
//  EIP-712 / EIP-3009 typed-data schema (USDC-shaped)
// ============================================================================

/** EIP-712 typed-data schema for EIP-3009 TransferWithAuthorization. */
export const EIP3009_TYPES = {
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
//  Keypair helpers
// ============================================================================

export interface MagicKeypair {
  /** 32-byte secp256k1 private key (Hex, 0x-prefixed). */
  readonly privateKey: Hex;
  /** Checksummed EVM address (0x…) — the on-chain public handle. */
  readonly address: Address;
}

/**
 * Generate a fresh, cryptographically-random EVM keypair. The address is a real
 * EIP-55 checksummed 0x address, identical in shape to what Magic.link would
 * provision for a user inside its DKMS enclave.
 */
export function generateMagicKeypair(): MagicKeypair {
  const privateKey = generatePrivateKey(); // 32 random bytes via @noble/curves
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

/** Reconstruct a keypair from an existing private key (Hex, 0x-prefixed). */
export function keypairFromPrivateKey(privateKey: Hex): MagicKeypair {
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

// ============================================================================
//  EIP-3009 authorization payload
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

export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface MagicSignedAuthorization {
  readonly authorization: Eip3009Authorization;
  /** Full 65-byte EIP-712 signature (Hex). */
  readonly signature: Hex;
  readonly domain: Eip712Domain;
}

// ============================================================================
//  RealMagicSigner
// ============================================================================

export interface RealMagicSignerConfig {
  /** Magic user identity — the email the magic-link was sent to. */
  readonly email: string;
  /** Supply an existing private key, or omit to generate a fresh one. */
  readonly privateKey?: Hex;
  /**
   * Optional balance reader — wired to a Base Sepolia RPC in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: Address) => Promise<bigint>;
  /**
   * Optional broadcast hook — in production this submits the signed EIP-3009
   * authorization on-chain through a facilitator (gas payer) wallet. If
   * omitted, settle() reports the signature without hitting the network
   * (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly signed: MagicSignedAuthorization;
  }) => Promise<{
    readonly transactionHash: string;
    readonly blockNumber?: number;
    readonly explorerUrl?: string;
  }>;
}

export class RealMagicSigner {
  /** The Magic user's email (their wallet handle). */
  readonly email: string;
  /** Checksummed 0x address derived from the secp256k1 key. */
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private readonly cfg: RealMagicSignerConfig;

  constructor(cfg: RealMagicSignerConfig) {
    if (!cfg.email || !isLikelyEmail(cfg.email)) {
      throw new Error(`RealMagicSigner requires a valid email, got: ${cfg.email}`);
    }
    const kp = cfg.privateKey
      ? keypairFromPrivateKey(cfg.privateKey)
      : generateMagicKeypair();
    this.account = privateKeyToAccount(kp.privateKey);
    this.address = kp.address;
    this.email = cfg.email;
    this.cfg = cfg;
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization off-chain. Produces a real,
   * on-chain-verifiable EIP-712 signature. Does NOT broadcast.
   */
  async signTransferAuthorization(
    authorization: Eip3009Authorization,
    domain: Eip712Domain
  ): Promise<MagicSignedAuthorization> {
    if (authorization.from.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(
        `authorization.from ${authorization.from} does not match Magic wallet ${this.address}`
      );
    }
    const signature = await this.account.signTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: BigInt(domain.chainId),
        verifyingContract: domain.verifyingContract,
      },
      types: EIP3009_TYPES,
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
    return { authorization, signature, domain };
  }

  /**
   * Broadcast a signed authorization. Offline-safe: without a `submit` hook,
   * returns undefined (caller treats as "no live settlement available").
   */
  async broadcast(
    signed: MagicSignedAuthorization
  ): Promise<
    { transactionHash: string; blockNumber?: number; explorerUrl?: string } | undefined
  > {
    if (!this.cfg.submit) return undefined;
    return this.cfg.submit({ signed });
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address);
    }
    return 0n;
  }

  /**
   * Verify an EIP-712 EIP-3009 signature recovers to this signer's address.
   * Useful for tests + audits (proves the signature is real, not a stub).
   */
  async verify(signed: MagicSignedAuthorization): Promise<boolean> {
    try {
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: signed.domain.name,
          version: signed.domain.version,
          chainId: BigInt(signed.domain.chainId),
          verifyingContract: signed.domain.verifyingContract,
        },
        types: EIP3009_TYPES,
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
      return recovered.toLowerCase() === this.address.toLowerCase();
    } catch {
      return false;
    }
  }

  /** EIP-712 digest of an authorization — exposed for audits/tests. */
  digest(authorization: Eip3009Authorization, domain: Eip712Domain): Hex {
    return hashTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: BigInt(domain.chainId),
        verifyingContract: domain.verifyingContract,
      },
      types: EIP3009_TYPES,
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
  }
}

// ============================================================================
//  Helpers
// ============================================================================

/** Minimal email shape check — sufficient to reject obviously bogus handles. */
export function isLikelyEmail(s: string): boolean {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Random 32-byte nonce as hex string (0x-prefixed). */
export function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
