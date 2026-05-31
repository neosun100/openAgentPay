/**
 * RealSolanaSigner — Ed25519 signer backed by @noble/curves, no @solana/web3.js.
 * ============================================================================
 *
 * The existing `DemoSolanaSigner` produces fake signatures for tests. This is
 * the production-shaped signer: it holds a real Ed25519 keypair, derives the
 * canonical base58 Solana address, and signs the Solana Pay transfer intent.
 *
 * Why not @solana/web3.js?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (keypair → address → signature) is fully
 *     real here; only the RPC *broadcast* needs a live cluster. We keep that
 *     pluggable via the optional `submit` hook so production can wire
 *     @solana/web3.js's `sendTransaction` without changing this file.
 *
 * Keypair material:
 *   - 32-byte Ed25519 seed (the "secret key" in Solana parlance is seed||pubkey
 *     = 64 bytes; we accept either and normalize).
 *   - Address = base58(pubkey) — exactly what Phantom/Solflare display.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";

import type { SolanaSigner } from "./connector.js";

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface SolanaKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly secretSeedHex: string;
  /** 64-byte secret key (seed||pubkey), base58 — the format `solana-keygen` emits. */
  readonly secretKeyBase58: string;
  /** 32-byte public key, base58 — the on-chain address. */
  readonly address: string;
}

/**
 * Generate a fresh, cryptographically-random Solana keypair.
 * The address is a real base58 Ed25519 pubkey, identical in shape to what a
 * devnet faucet would fund.
 */
export function generateSolanaKeypair(): SolanaKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Reconstruct a keypair from a 32-byte seed (hex with/without 0x, or base58). */
export function keypairFromSeed(seed: Uint8Array): SolanaKeypair {
  if (seed.length !== 32) {
    throw new Error(`Solana seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  const secretKey64 = new Uint8Array(64);
  secretKey64.set(seed, 0);
  secretKey64.set(pubkey, 32);
  return {
    secretSeedHex: toHex(seed),
    secretKeyBase58: base58.encode(secretKey64),
    address: base58.encode(pubkey),
  };
}

/**
 * Load a keypair from a base58-encoded secret key. Accepts both the 64-byte
 * (seed||pubkey) form `solana-keygen` produces and the bare 32-byte seed.
 */
export function keypairFromBase58(secretKeyBase58: string): SolanaKeypair {
  const bytes = base58.decode(secretKeyBase58);
  if (bytes.length === 64) return keypairFromSeed(bytes.slice(0, 32));
  if (bytes.length === 32) return keypairFromSeed(bytes);
  throw new Error(
    `Solana secret key must decode to 32 or 64 bytes, got ${bytes.length}`
  );
}

// ============================================================================
//  RealSolanaSigner
// ============================================================================

export interface RealSolanaSignerConfig {
  /** Base58 secret key (64-byte solana-keygen form, or 32-byte seed). */
  readonly secretKeyBase58?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /**
   * Optional balance reader — wired to a Helius/devnet RPC in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    splTokenMint?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to @solana/web3.js sendTransaction in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly splTokenMint?: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
  }) => Promise<{ readonly slot?: number; readonly explorerUrl?: string }>;
  /** Cluster for explorer URLs. */
  readonly cluster?: "mainnet-beta" | "devnet" | "testnet";
}

export class RealSolanaSigner implements SolanaSigner {
  readonly address: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealSolanaSignerConfig;
  private readonly cluster: "mainnet-beta" | "devnet" | "testnet";

  constructor(cfg: RealSolanaSignerConfig = {}) {
    let kp: SolanaKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.secretKeyBase58) {
      kp = keypairFromBase58(cfg.secretKeyBase58);
    } else {
      kp = generateSolanaKeypair();
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.address = kp.address;
    this.cfg = cfg;
    this.cluster = cfg.cluster ?? "devnet";
  }

  /**
   * Sign a deterministic message derived from the transfer intent. This is a
   * real Ed25519 signature over the canonical Solana-Pay transfer descriptor.
   * The production `submit` hook is responsible for assembling + broadcasting
   * the actual on-chain transaction; the signature here is the agent's
   * cryptographic authorization, returned base58 (Solana's tx-signature form).
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    splTokenMint?: string;
    reference?: string;
    memo?: string;
  }): Promise<{ signature: string; slot?: number; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.splTokenMint !== undefined
        ? { splTokenMint: input.splTokenMint }
        : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = sha256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signature = base58.encode(sigBytes); // base58 — matches Solana tx-sig form

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.splTokenMint !== undefined
          ? { splTokenMint: input.splTokenMint }
          : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.address,
      });
      return {
        signature,
        ...(res.slot !== undefined ? { slot: res.slot } : {}),
        explorerUrl:
          res.explorerUrl ?? this.explorerUrl(signature),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return {
      signature,
      slot: 0,
      explorerUrl: this.explorerUrl(signature),
    };
  }

  async getBalance(splTokenMint?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, splTokenMint);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(
    signatureBase58: string,
    descriptor: string
  ): boolean {
    try {
      const sig = base58.decode(signatureBase58);
      const msg = sha256(new TextEncoder().encode(descriptor));
      const pubkey = base58.decode(this.address);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(sig: string): string {
    const suffix = this.cluster === "mainnet-beta" ? "" : `?cluster=${this.cluster}`;
    return `https://explorer.solana.com/tx/${sig}${suffix}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Solana Pay transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  splTokenMint?: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `solana-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `mint=${fields.splTokenMint ?? "native"}`,
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
