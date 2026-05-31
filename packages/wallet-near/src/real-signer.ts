/**
 * RealNearSigner — Ed25519 signer backed by @noble/curves, no near-api-js.
 * ============================================================================
 *
 * Production-shaped NEAR signer that holds a real Ed25519 keypair, derives the
 * canonical NEAR *implicit account* (lowercase-hex of the 32-byte public key),
 * and signs the transfer intent with a real, verifiable Ed25519 signature.
 *
 * Why not near-api-js?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (keypair → implicit account → signature) is
 *     fully real here; only the RPC *broadcast* needs a live network. We keep
 *     that pluggable via the optional `submit` hook so production can wire
 *     near-api-js's `signAndSendTransaction` without changing this file.
 *
 * NEAR keypair material:
 *   - Implicit account ID = lowercase hex of the 32-byte Ed25519 pubkey
 *     (64 hex chars, NO 0x prefix). This is what a NEAR faucet funds.
 *   - Private key string format = "ed25519:" + base58(64-byte secretKey),
 *     where the 64-byte secretKey is seed||pubkey (the near-cli / nearkey form).
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";

import type { NearSigner } from "./connector.js";

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface NearKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly secretSeedHex: string;
  /** Private key string: "ed25519:" + base58(seed||pubkey) — near-cli form. */
  readonly secretKey: string;
  /** Public key string: "ed25519:" + base58(pubkey). */
  readonly publicKey: string;
  /** NEAR implicit account id = lowercase hex(pubkey), 64 chars, no 0x. */
  readonly accountId: string;
}

const ED25519_PREFIX = "ed25519:";

/**
 * Generate a fresh, cryptographically-random NEAR keypair.
 * The accountId is a real implicit account (64 lowercase hex), identical in
 * shape to what a testnet faucet would fund.
 */
export function generateNearKeypair(): NearKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Reconstruct a keypair from a 32-byte seed. */
export function keypairFromSeed(seed: Uint8Array): NearKeypair {
  if (seed.length !== 32) {
    throw new Error(`NEAR seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  const secretKey64 = new Uint8Array(64);
  secretKey64.set(seed, 0);
  secretKey64.set(pubkey, 32);
  return {
    secretSeedHex: toHex(seed),
    secretKey: ED25519_PREFIX + base58.encode(secretKey64),
    publicKey: ED25519_PREFIX + base58.encode(pubkey),
    accountId: toHex(pubkey), // implicit account = lowercase hex of pubkey
  };
}

/**
 * Load a keypair from a NEAR private key string ("ed25519:" + base58(...)).
 * Accepts both the 64-byte (seed||pubkey) form near-cli produces and a bare
 * 32-byte seed.
 */
export function keypairFromSecretKey(secretKey: string): NearKeypair {
  if (!secretKey.startsWith(ED25519_PREFIX)) {
    throw new Error(`NEAR secret key must start with "${ED25519_PREFIX}"`);
  }
  const bytes = base58.decode(secretKey.slice(ED25519_PREFIX.length));
  if (bytes.length === 64) return keypairFromSeed(bytes.slice(0, 32));
  if (bytes.length === 32) return keypairFromSeed(bytes);
  throw new Error(
    `NEAR secret key must decode to 32 or 64 bytes, got ${bytes.length}`
  );
}

// ============================================================================
//  RealNearSigner
// ============================================================================

export interface RealNearSignerConfig {
  /** NEAR private key string ("ed25519:" + base58(64-byte secretKey)). */
  readonly secretKey?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /**
   * Optional named account override. NEAR supports named accounts that end in
   * ".testnet" / ".near"; when set, this is used as the signer's accountId
   * instead of the implicit (hex) account. The keypair still signs.
   */
  readonly accountId?: string;
  /**
   * Optional balance reader — wired to a NEAR RPC in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    accountId: string,
    token?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to near-api-js signAndSendTransaction in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly token?: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
    readonly publicKey: string;
  }) => Promise<{ readonly blockHash?: string; readonly explorerUrl?: string }>;
  /** Network for explorer URLs. */
  readonly network?: "mainnet" | "testnet";
}

export class RealNearSigner implements NearSigner {
  readonly accountId: string;
  readonly publicKey: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealNearSignerConfig;
  private readonly network: "mainnet" | "testnet";

  constructor(cfg: RealNearSignerConfig = {}) {
    let kp: NearKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.secretKey) {
      kp = keypairFromSecretKey(cfg.secretKey);
    } else {
      kp = generateNearKeypair();
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    // Named account overrides implicit; otherwise use implicit hex account.
    this.accountId = cfg.accountId ?? kp.accountId;
    this.publicKey = kp.publicKey;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Sign a deterministic message derived from the transfer intent. This is a
   * real Ed25519 signature over the canonical NEAR transfer descriptor. The
   * production `submit` hook is responsible for assembling + broadcasting the
   * actual on-chain transaction; the signature here is the agent's
   * cryptographic authorization, returned base58.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    token?: string;
    reference?: string;
    memo?: string;
  }): Promise<{ signature: string; blockHash?: string; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.accountId,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = sha256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signature = base58.encode(sigBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.token !== undefined ? { token: input.token } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.accountId,
        publicKey: this.publicKey,
      });
      return {
        signature,
        ...(res.blockHash !== undefined ? { blockHash: res.blockHash } : {}),
        explorerUrl: res.explorerUrl ?? this.explorerUrl(signature),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return {
      signature,
      blockHash: "",
      explorerUrl: this.explorerUrl(signature),
    };
  }

  async getBalance(token?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.accountId, token);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureBase58: string, descriptor: string): boolean {
    try {
      const sig = base58.decode(signatureBase58);
      const msg = sha256(new TextEncoder().encode(descriptor));
      // public key bytes from the implicit hex account (or recompute from seed)
      const pubkey = ed25519.getPublicKey(this.seed);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(sig: string): string {
    const host =
      this.network === "mainnet"
        ? "https://explorer.near.org"
        : "https://explorer.testnet.near.org";
    return `${host}/transactions/${sig}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a NEAR transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  token?: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `near-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `token=${fields.token ?? "near"}`,
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
