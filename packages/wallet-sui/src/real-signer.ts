/**
 * RealSuiSigner — Ed25519 signer backed by @noble/curves, no @mysten/sui SDK.
 * ============================================================================
 *
 * Real cryptographic identity for Sui, computed fully offline:
 *
 *   - Keypair: 32-byte Ed25519 seed → 32-byte Ed25519 pubkey.
 *   - Address: blake2b-256( 0x00 (Ed25519 scheme flag) || pubkey )  →  hex,
 *     "0x"-prefixed, 64 hex chars. This is exactly what Sui Wallet / Suiet show.
 *   - Private key export: bech32 "suiprivkey1…" = bech32( hrp="suiprivkey",
 *     data = 0x00 (scheme flag) || 32-byte seed ). Matches `sui keytool export`.
 *
 * Why not @mysten/sui?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The identity (keypair → address → signature) is fully real here; only
 *     the on-chain *broadcast* needs a live fullnode, kept pluggable via the
 *     optional `submit` hook so production can wire `SuiClient.executeTransactionBlock`
 *     without touching this file.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "@scure/base";

import type { SuiSigner } from "./connector.js";

// ============================================================================
//  Constants
// ============================================================================

/** Sui signature-scheme flag for Ed25519. */
export const SUI_ED25519_FLAG = 0x00;
/** Human-readable prefix for bech32-encoded Sui private keys. */
export const SUI_PRIVATE_KEY_HRP = "suiprivkey";
/** Address length in bytes (Sui addresses are 32-byte blake2b-256 digests). */
const SUI_ADDRESS_BYTES = 32;

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface SuiKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly seedHex: string;
  /** bech32-encoded private key — `suiprivkey1…`, the `sui keytool` export form. */
  readonly suiprivkeyBech32: string;
  /** 32-byte Ed25519 public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** Sui address — "0x" + 64 hex chars. */
  readonly address: string;
}

/**
 * Derive a Sui address from a raw 32-byte Ed25519 public key.
 * address = blake2b-256( flag(0x00) || pubkey ) → 0x-prefixed hex.
 */
export function suiAddressFromPublicKey(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) {
    throw new Error(`Sui Ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  const tagged = new Uint8Array(1 + pubkey.length);
  tagged[0] = SUI_ED25519_FLAG;
  tagged.set(pubkey, 1);
  const digest = blake2b(tagged, { dkLen: SUI_ADDRESS_BYTES });
  return "0x" + toHex(digest);
}

/** Reconstruct a keypair from a 32-byte Ed25519 seed. */
export function keypairFromSeed(seed: Uint8Array): SuiKeypair {
  if (seed.length !== 32) {
    throw new Error(`Sui seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  return {
    seedHex: toHex(seed),
    suiprivkeyBech32: encodeSuiPrivateKey(seed),
    publicKeyHex: toHex(pubkey),
    address: suiAddressFromPublicKey(pubkey),
  };
}

/**
 * Generate a fresh, cryptographically-random Sui keypair.
 * The address is a real blake2b-256 Sui address, identical in shape to what a
 * testnet faucet would fund.
 */
export function generateSuiKeypair(): SuiKeypair & { seed: Uint8Array } {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  const kp = keypairFromSeed(seed);
  return { ...kp, seed };
}

/**
 * Encode a 32-byte seed as a bech32 `suiprivkey1…` string.
 * data words = bech32.toWords( flag(0x00) || seed ).
 */
export function encodeSuiPrivateKey(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`Sui seed must be 32 bytes, got ${seed.length}`);
  }
  const flagged = new Uint8Array(1 + seed.length);
  flagged[0] = SUI_ED25519_FLAG;
  flagged.set(seed, 1);
  const words = bech32.toWords(flagged);
  return bech32.encode(SUI_PRIVATE_KEY_HRP, words, 120);
}

/**
 * Decode a `suiprivkey1…` bech32 string back to a keypair.
 * Throws if the hrp is wrong or the scheme flag is not Ed25519.
 */
export function keypairFromSuiPrivateKey(suiprivkey: string): SuiKeypair {
  const { prefix, words } = bech32.decode(suiprivkey as `${string}1${string}`, 120);
  if (prefix !== SUI_PRIVATE_KEY_HRP) {
    throw new Error(
      `Expected hrp "${SUI_PRIVATE_KEY_HRP}", got "${prefix}"`
    );
  }
  const data = bech32.fromWords(words);
  if (data.length !== 33) {
    throw new Error(`Decoded private key must be 33 bytes (flag||seed), got ${data.length}`);
  }
  const flag = data[0];
  if (flag !== SUI_ED25519_FLAG) {
    throw new Error(`Unsupported signature scheme flag 0x${flag?.toString(16)} (only Ed25519 0x00)`);
  }
  return keypairFromSeed(Uint8Array.from(data.slice(1)));
}

// ============================================================================
//  RealSuiSigner
// ============================================================================

export interface RealSuiSignerConfig {
  /** Supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /** Or supply a bech32 `suiprivkey1…` private key. */
  readonly suiprivkeyBech32?: string;
  /**
   * Optional balance reader — wired to a Sui fullnode RPC in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    coinType?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to SuiClient.executeTransactionBlock in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly coinType?: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
  }) => Promise<{ readonly digest?: string; readonly explorerUrl?: string }>;
  /** Network for explorer URLs. */
  readonly network?: "mainnet" | "testnet" | "devnet";
}

export class RealSuiSigner implements SuiSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealSuiSignerConfig;
  private readonly network: "mainnet" | "testnet" | "devnet";

  constructor(cfg: RealSuiSignerConfig = {}) {
    let kp: SuiKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.suiprivkeyBech32) {
      kp = keypairFromSuiPrivateKey(cfg.suiprivkeyBech32);
    } else {
      kp = keypairFromSeed(ed25519.utils.randomPrivateKey());
    }
    this.seed = hexToBytes(kp.seedHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Sign a deterministic message derived from the transfer intent. This is a
   * real Ed25519 signature over the canonical Sui transfer descriptor, hashed
   * with blake2b-256 (Sui's intent-message digest hash). The production
   * `submit` hook assembles + broadcasts the actual TransactionBlock; the
   * signature here is the agent's cryptographic authorization.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    coinType?: string;
    reference?: string;
    memo?: string;
  }): Promise<{ signature: string; digest?: string; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.coinType !== undefined ? { coinType: input.coinType } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = blake2b(new TextEncoder().encode(descriptor), { dkLen: 32 });
    const sigBytes = ed25519.sign(msg, this.seed);
    const signature = toHex(sigBytes); // hex — verifiable Ed25519 signature

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.coinType !== undefined ? { coinType: input.coinType } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.address,
      });
      const digest = res.digest ?? signature;
      return {
        signature,
        digest,
        explorerUrl: res.explorerUrl ?? this.explorerUrl(digest),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return {
      signature,
      digest: signature,
      explorerUrl: this.explorerUrl(signature),
    };
  }

  async getBalance(coinType?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, coinType);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msg = blake2b(new TextEncoder().encode(descriptor), { dkLen: 32 });
      const pubkey = hexToBytes(this.publicKeyHex);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(digest: string): string {
    return `https://suiscan.xyz/${this.network}/tx/${digest}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Sui transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  coinType?: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `sui-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `coin=${fields.coinType ?? "0x2::sui::SUI"}`,
    `ref=${fields.reference ?? ""}`,
    `memo=${fields.memo ?? ""}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  Hex helpers (no Buffer dependency — works in browser + node)
// ============================================================================

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
