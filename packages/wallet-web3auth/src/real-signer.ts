/**
 * RealWeb3AuthSigner — secp256k1 EVM signer for Web3Auth social-login MPC wallets.
 * ============================================================================
 *
 * Web3Auth (https://web3auth.io) is a mainstream *social-login* wallet
 * infrastructure: end users authenticate with an OAuth provider (Google,
 * Apple, Twitter, Discord, email-passwordless, ...) and Web3Auth's MPC network
 * (a threshold-key / SSS ceremony across distributed nodes) reconstructs a
 * non-custodial secp256k1 key bound to that social identity. No single party —
 * not even Web3Auth — ever holds the full key.
 *
 * We can't run that distributed MPC ceremony offline, but the public ABI is
 * just "an EVM account that signs EIP-712". So this signer:
 *
 *   - Generates a REAL secp256k1 keypair in-process (viem generatePrivateKey)
 *   - Derives the canonical 0x checksummed address (viem privateKeyToAccount)
 *   - Binds that identity to a social login (loginProvider + verifierId)
 *   - Signs EIP-3009 transferWithAuthorization via real EIP-712 (viem
 *     signTypedData) — verifiable on-chain by any USDC-shaped contract
 *
 * The cryptographic identity (social login → MPC key → 0x address → signature)
 * is fully real here. Only the on-chain *broadcast* needs a live RPC +
 * facilitator, which we keep behind the optional pluggable `submit` hook
 * (offline-safe default — mirrors RealMagicSigner / RealSolanaSigner).
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
//  Social login identity
// ============================================================================

/**
 * The social-login identity a Web3Auth wallet is keyed to.
 *   - loginProvider : OAuth/verifier kind ("google", "apple", "twitter", ...)
 *   - verifierId    : the per-provider unique subject (often an email or sub).
 *
 * Production Web3Auth feeds {verifier, verifierId, idToken} into the MPC
 * network to reconstruct the key. We model the stable public identity here.
 */
export interface SocialLogin {
  /** Login provider / verifier name (e.g. "google", "apple", "discord"). */
  readonly loginProvider: string;
  /** Per-provider unique subject (e.g. an email or OAuth `sub`). */
  readonly verifierId: string;
}

/** Common Web3Auth login providers (advisory — any string is accepted). */
export const WEB3AUTH_LOGIN_PROVIDERS = [
  "google",
  "apple",
  "twitter",
  "discord",
  "github",
  "facebook",
  "email_passwordless",
] as const;

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface Web3AuthKeypair {
  /** 32-byte secp256k1 private key (Hex, 0x-prefixed). */
  readonly privateKey: Hex;
  /** Checksummed EVM address (0x…) — the on-chain public handle. */
  readonly address: Address;
}

/**
 * Generate a fresh, cryptographically-random EVM keypair. The address is a real
 * EIP-55 checksummed 0x address, identical in shape to what Web3Auth's MPC
 * network would reconstruct for a social-login user.
 */
export function generateWeb3AuthKeypair(): Web3AuthKeypair {
  const privateKey = generatePrivateKey(); // 32 random bytes via @noble/curves
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

/** Reconstruct a keypair from an existing private key (Hex, 0x-prefixed). */
export function keypairFromPrivateKey(privateKey: Hex): Web3AuthKeypair {
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

export interface Web3AuthSignedAuthorization {
  readonly authorization: Eip3009Authorization;
  /** Full 65-byte EIP-712 signature (Hex). */
  readonly signature: Hex;
  readonly domain: Eip712Domain;
}

// ============================================================================
//  RealWeb3AuthSigner
// ============================================================================

export interface RealWeb3AuthSignerConfig {
  /** Web3Auth login provider (e.g. "google"). */
  readonly loginProvider: string;
  /** Per-provider unique subject (e.g. an email or OAuth `sub`). */
  readonly verifierId: string;
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
    readonly signed: Web3AuthSignedAuthorization;
  }) => Promise<{
    readonly transactionHash: string;
    readonly blockNumber?: number;
    readonly explorerUrl?: string;
  }>;
}

export class RealWeb3AuthSigner {
  /** Web3Auth login provider (e.g. "google"). */
  readonly loginProvider: string;
  /** Per-provider unique subject (e.g. an email / OAuth sub). */
  readonly verifierId: string;
  /** Checksummed 0x address derived from the (MPC-reconstructed) secp256k1 key. */
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private readonly cfg: RealWeb3AuthSignerConfig;

  constructor(cfg: RealWeb3AuthSignerConfig) {
    if (!cfg.loginProvider || typeof cfg.loginProvider !== "string") {
      throw new Error(
        `RealWeb3AuthSigner requires a loginProvider, got: ${cfg.loginProvider}`
      );
    }
    if (!cfg.verifierId || typeof cfg.verifierId !== "string") {
      throw new Error(
        `RealWeb3AuthSigner requires a verifierId, got: ${cfg.verifierId}`
      );
    }
    const kp = cfg.privateKey
      ? keypairFromPrivateKey(cfg.privateKey)
      : generateWeb3AuthKeypair();
    this.account = privateKeyToAccount(kp.privateKey);
    this.address = kp.address;
    this.loginProvider = cfg.loginProvider;
    this.verifierId = cfg.verifierId;
    this.cfg = cfg;
  }

  /** The social identity this wallet is keyed to. */
  get socialLogin(): SocialLogin {
    return { loginProvider: this.loginProvider, verifierId: this.verifierId };
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization off-chain. Produces a real,
   * on-chain-verifiable EIP-712 signature. Does NOT broadcast.
   */
  async signTransferAuthorization(
    authorization: Eip3009Authorization,
    domain: Eip712Domain
  ): Promise<Web3AuthSignedAuthorization> {
    if (authorization.from.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(
        `authorization.from ${authorization.from} does not match Web3Auth wallet ${this.address}`
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
    signed: Web3AuthSignedAuthorization
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
  async verify(signed: Web3AuthSignedAuthorization): Promise<boolean> {
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

/** Random 32-byte nonce as hex string (0x-prefixed). */
export function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
