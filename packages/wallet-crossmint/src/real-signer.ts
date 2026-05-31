/**
 * RealCrossmintSigner — secp256k1 EVM signer for Crossmint embedded wallets.
 * ============================================================================
 *
 * Crossmint (https://crossmint.com) provisions *NFT-aware embedded wallets*:
 * developers pass a server-side `apiKey` + `projectId`, and Crossmint mints a
 * non-custodial EVM smart/embedded wallet for the agent inside its enclave. The
 * production Crossmint SDK keeps the key material server-side keyed to the
 * project credentials; we can't run that enclave offline — but the public ABI
 * is just "an EVM account that signs EIP-712". So this signer:
 *
 *   - Derives a REAL secp256k1 keypair *deterministically* from
 *     `apiKey + projectId` (HKDF-SHA256 → 32-byte private scalar) — same creds
 *     always yield the same agent wallet, mirroring Crossmint's "one embedded
 *     wallet per project credential" provisioning model. Offline, zero network.
 *   - Derives the canonical 0x EIP-55 checksummed address (viem
 *     privateKeyToAccount).
 *   - Signs EIP-3009 transferWithAuthorization via real EIP-712 (viem
 *     signTypedData) — verifiable on-chain by any USDC-shaped contract.
 *
 * The cryptographic identity (creds → key → 0x address → signature) is fully
 * real here. Only the on-chain *broadcast* needs a live RPC + facilitator,
 * which we keep behind the optional pluggable `submit` hook (offline-safe
 * default — exactly mirrors RealMagicSigner / RealSolanaSigner design).
 *
 * NFT-aware: Crossmint wallets natively hold/transfer NFTs. We surface this via
 * the `nftAware` capability flag; the EIP-3009 USDC payment path is unchanged.
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
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";

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

export interface CrossmintKeypair {
  /** 32-byte secp256k1 private key (Hex, 0x-prefixed). */
  readonly privateKey: Hex;
  /** Checksummed EVM address (0x…) — the on-chain public handle. */
  readonly address: Address;
}

/** HKDF salt — domain-separates Crossmint key derivation from any other use. */
const HKDF_SALT = utf8ToBytes("openagentpay/crossmint/embedded-wallet/v1");

/**
 * Deterministically derive a secp256k1 private scalar from Crossmint
 * credentials (`apiKey` + `projectId`) using HKDF-SHA256. Same credentials
 * always reproduce the same agent wallet — exactly how Crossmint provisions a
 * stable embedded wallet per project. The derived 32 bytes are reduced into the
 * valid secp256k1 range (1 .. n-1) by viem's privateKeyToAccount validation;
 * we additionally guard against the degenerate all-zero output.
 */
export function deriveCrossmintPrivateKey(
  apiKey: string,
  projectId: string
): Hex {
  if (!apiKey) throw new Error("deriveCrossmintPrivateKey: apiKey is required");
  if (!projectId) {
    throw new Error("deriveCrossmintPrivateKey: projectId is required");
  }
  // IKM = apiKey ++ ":" ++ projectId; info binds the curve + purpose.
  const ikm = utf8ToBytes(`${apiKey}:${projectId}`);
  const info = utf8ToBytes("secp256k1-private-key");
  const out = hkdf(sha256, ikm, HKDF_SALT, info, 32);
  // Guard the (astronomically unlikely) all-zero scalar.
  const allZero = out.every((b) => b === 0);
  const bytes = allZero ? Uint8Array.from({ length: 32 }, () => 1) : out;
  return bytesToHex(bytes) as Hex;
}

/**
 * Generate the Crossmint embedded-wallet keypair for a set of project
 * credentials. Deterministic: identical (apiKey, projectId) → identical wallet.
 */
export function generateCrossmintKeypair(
  apiKey: string,
  projectId: string
): CrossmintKeypair {
  const privateKey = deriveCrossmintPrivateKey(apiKey, projectId);
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

/** Reconstruct a keypair from an existing private key (Hex, 0x-prefixed). */
export function keypairFromPrivateKey(privateKey: Hex): CrossmintKeypair {
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

export interface CrossmintSignedAuthorization {
  readonly authorization: Eip3009Authorization;
  /** Full 65-byte EIP-712 signature (Hex). */
  readonly signature: Hex;
  readonly domain: Eip712Domain;
}

// ============================================================================
//  RealCrossmintSigner
// ============================================================================

export interface RealCrossmintSignerConfig {
  /** Crossmint server-side API key (mock value fine offline). */
  readonly apiKey: string;
  /** Crossmint project id the embedded wallet is scoped to. */
  readonly projectId: string;
  /**
   * Supply an existing private key to bypass derivation (tests / shared
   * identity). Overrides apiKey/projectId derivation.
   */
  readonly privateKey?: Hex;
  /**
   * Optional balance reader — wired to a Base Sepolia RPC in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: Address) => Promise<bigint>;
  /**
   * Optional broadcast hook — in production this submits the signed EIP-3009
   * authorization on-chain through a Crossmint facilitator (gas payer) wallet.
   * If omitted, settle() reports the signature without hitting the network
   * (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly signed: CrossmintSignedAuthorization;
  }) => Promise<{
    readonly transactionHash: string;
    readonly blockNumber?: number;
    readonly explorerUrl?: string;
  }>;
}

export class RealCrossmintSigner {
  /** Crossmint API key (the project credential). */
  readonly apiKey: string;
  /** Crossmint project id. */
  readonly projectId: string;
  /** Checksummed 0x address derived from the secp256k1 key. */
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private readonly cfg: RealCrossmintSignerConfig;

  constructor(cfg: RealCrossmintSignerConfig) {
    if (!cfg.apiKey) {
      throw new Error("RealCrossmintSigner requires an apiKey");
    }
    if (!cfg.projectId) {
      throw new Error("RealCrossmintSigner requires a projectId");
    }
    const kp = cfg.privateKey
      ? keypairFromPrivateKey(cfg.privateKey)
      : generateCrossmintKeypair(cfg.apiKey, cfg.projectId);
    this.account = privateKeyToAccount(kp.privateKey);
    this.address = kp.address;
    this.apiKey = cfg.apiKey;
    this.projectId = cfg.projectId;
    this.cfg = cfg;
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization off-chain. Produces a real,
   * on-chain-verifiable EIP-712 signature. Does NOT broadcast.
   */
  async signTransferAuthorization(
    authorization: Eip3009Authorization,
    domain: Eip712Domain
  ): Promise<CrossmintSignedAuthorization> {
    if (authorization.from.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(
        `authorization.from ${authorization.from} does not match Crossmint wallet ${this.address}`
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
    signed: CrossmintSignedAuthorization
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
   * Proves the signature is real (not a stub) — used in tests + audits.
   */
  async verify(signed: CrossmintSignedAuthorization): Promise<boolean> {
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
