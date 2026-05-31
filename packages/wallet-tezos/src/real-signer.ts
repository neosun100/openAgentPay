/**
 * RealTezosSigner — Ed25519 signer backed by @noble/curves, no taquito.
 * ============================================================================
 *
 * Mirrors `RealStellarSigner`/`RealSolanaSigner` but for the TEZOS chain model:
 *
 *   - Crypto:   Ed25519 (the "tz1" implicit-account curve family)
 *   - Address:  base58check( [0x06,0xA1,0x9F] (tz1 prefix) || blake2b160(pubkey) )
 *               → 36-char string starting with "tz1" (e.g. tz1VSU...).
 *   - SecretKey: base58check( [0x0D,0x0F,0x3A,0x07] (edsk prefix) || 32-byte seed )
 *               → starts with "edsk" (the seed form Tezos tooling emits as edsk2).
 *   - Asset:    XTZ (6 dp, "mutez" = micro-tez).
 *   - Settlement: a `transaction` operation — broadcast deferred behind the
 *               optional, pluggable `submit` hook (offline-safe default).
 *
 * Tezos base58check prefixes are MULTI-BYTE (unlike Bitcoin/Tron's single
 * version byte). The prefix is chosen so that, after base58, the human-readable
 * string begins with the expected ASCII tag ("tz1", "edsk", ...). We still use
 * the standard double-SHA256 4-byte checksum.
 *
 * The cryptographic identity (seed → pubkey → tz1 address → signature) is fully
 * REAL and offline-verifiable via `verify()`. Only the on-chain broadcast needs
 * a live node; that lives in the `submit` hook so production can wire taquito's
 * `RpcClient.injectOperation` without touching this file.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2";
import { sha256 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";

// ============================================================================
//  Tezos base58check prefixes (multi-byte, per the Tezos base58 prefix table)
// ============================================================================

/** tz1 (Ed25519 public key hash → implicit account address). */
export const PREFIX_TZ1 = Uint8Array.from([0x06, 0xa1, 0x9f]);
/** edsk (Ed25519 32-byte seed). */
export const PREFIX_EDSK_SEED = Uint8Array.from([0x0d, 0x0f, 0x3a, 0x07]);
/** edpk (Ed25519 public key). */
export const PREFIX_EDPK = Uint8Array.from([0x0d, 0x0f, 0x25, 0xd9]);
/** edsig (Ed25519 signature). */
export const PREFIX_EDSIG = Uint8Array.from([0x09, 0xf5, 0xcd, 0x86, 0x12]);

// ============================================================================
//  base58check codec (Tezos = double-SHA256 4-byte checksum, multi-byte prefix)
// ============================================================================

/** base58check encode of `prefix || payload`, appending sha256(sha256())[:4]. */
export function base58CheckEncode(prefix: Uint8Array, payload: Uint8Array): string {
  const data = new Uint8Array(prefix.length + payload.length);
  data.set(prefix, 0);
  data.set(payload, prefix.length);
  const checksum = sha256(sha256(data)).slice(0, 4);
  const full = new Uint8Array(data.length + 4);
  full.set(data, 0);
  full.set(checksum, data.length);
  return base58.encode(full);
}

/**
 * base58check decode, stripping `prefix`. Verifies the checksum AND that the
 * decoded bytes start with the expected prefix. Throws on any mismatch.
 */
export function base58CheckDecode(prefix: Uint8Array, encoded: string): Uint8Array {
  const full = base58.decode(encoded);
  if (full.length < prefix.length + 4) {
    throw new Error(`base58check string too short: ${encoded}`);
  }
  const data = full.slice(0, full.length - 4);
  const checksum = full.slice(full.length - 4);
  const expected = sha256(sha256(data)).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error(`base58check checksum mismatch for ${encoded}`);
    }
  }
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) {
      throw new Error(`base58check prefix mismatch for ${encoded}`);
    }
  }
  return data.slice(prefix.length);
}

// ============================================================================
//  Address / key codec
// ============================================================================

/** blake2b-160 (20-byte) digest — Tezos public-key-hash function. */
export function blake2b160(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 20 });
}

/** Encode a 32-byte Ed25519 public key as a tz1 address ("tz1...", ~36 chars). */
export function encodeTz1Address(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) {
    throw new Error(`Tezos public key must be 32 bytes, got ${pubkey.length}`);
  }
  return base58CheckEncode(PREFIX_TZ1, blake2b160(pubkey));
}

/** Encode a 32-byte Ed25519 seed as an edsk secret key ("edsk..."). */
export function encodeEdskSeed(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`Tezos seed must be 32 bytes, got ${seed.length}`);
  }
  return base58CheckEncode(PREFIX_EDSK_SEED, seed);
}

/** Encode a 32-byte Ed25519 public key as an edpk key ("edpk..."). */
export function encodeEdpk(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) {
    throw new Error(`Tezos public key must be 32 bytes, got ${pubkey.length}`);
  }
  return base58CheckEncode(PREFIX_EDPK, pubkey);
}

/** Encode a 64-byte Ed25519 signature as an edsig string ("edsig..."). */
export function encodeEdsig(sig: Uint8Array): string {
  if (sig.length !== 64) {
    throw new Error(`Tezos signature must be 64 bytes, got ${sig.length}`);
  }
  return base58CheckEncode(PREFIX_EDSIG, sig);
}

/** Decode an edsk seed string ("edsk...") back to the raw 32-byte seed. */
export function decodeEdskSeed(secret: string): Uint8Array {
  const seed = base58CheckDecode(PREFIX_EDSK_SEED, secret);
  if (seed.length !== 32) {
    throw new Error(`edsk seed payload must be 32 bytes, got ${seed.length}`);
  }
  return seed;
}

/** Decode an edsig signature string ("edsig...") back to the raw 64-byte sig. */
export function decodeEdsig(sig: string): Uint8Array {
  const raw = base58CheckDecode(PREFIX_EDSIG, sig);
  if (raw.length !== 64) {
    throw new Error(`edsig payload must be 64 bytes, got ${raw.length}`);
  }
  return raw;
}

/** True iff `s` looks like a valid tz1 address (starts "tz1", ~36 chars, CRC ok). */
export function isValidTz1Address(s: string): boolean {
  try {
    base58CheckDecode(PREFIX_TZ1, s);
    return s.startsWith("tz1") && s.length >= 36 && s.length <= 37;
  } catch {
    return false;
  }
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface TezosKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly secretSeedHex: string;
  /** edsk secret key ("edsk...") — the 32-byte-seed form (edsk2). */
  readonly secret: string;
  /** edpk public key ("edpk..."). */
  readonly publicKey: string;
  /** tz1 implicit account address ("tz1...", ~36 chars) — the on-chain address. */
  readonly address: string;
}

/** Build a keypair from a 32-byte raw Ed25519 seed. */
export function keypairFromSeed(seed: Uint8Array): TezosKeypair {
  if (seed.length !== 32) {
    throw new Error(`Tezos seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  return {
    secretSeedHex: toHex(seed),
    secret: encodeEdskSeed(seed),
    publicKey: encodeEdpk(pubkey),
    address: encodeTz1Address(pubkey),
  };
}

/**
 * Generate a fresh, cryptographically-random Tezos keypair fully in-process.
 * The address is a real tz1 implicit account, identical in shape to one a
 * Ghostnet faucet would fund.
 */
export function generateTezosKeypair(): TezosKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Load a keypair from an edsk secret key string ("edsk..."). */
export function keypairFromSecret(secret: string): TezosKeypair {
  return keypairFromSeed(decodeEdskSeed(secret));
}

// ============================================================================
//  RealTezosSigner
// ============================================================================

export interface RealTezosSignerConfig {
  /** edsk secret key ("edsk..."). */
  readonly secret?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /**
   * Optional balance reader — wired to a Tezos RPC `/balance` call in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to taquito injectOperation in production.
   * If omitted, signAndSubmit() returns the locally-computed signature without
   * hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
  }) => Promise<{ readonly opHash?: string; readonly explorerUrl?: string }>;
  /** Network for explorer URLs + signing domain separation. */
  readonly network?: "mainnet" | "ghostnet";
}

export interface TezosSignResult {
  /** edsig-encoded Ed25519 signature (base58check, "edsig..."). */
  readonly signature: string;
  /** Raw 64-byte signature, hex — useful for cross-checks. */
  readonly signatureHex: string;
  /** Operation hash reference (the submit hook's opHash, else local sig). */
  readonly opHash: string;
  readonly explorerUrl: string;
}

export class RealTezosSigner {
  readonly address: string;
  readonly publicKey: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealTezosSignerConfig;
  private readonly network: "mainnet" | "ghostnet";

  constructor(cfg: RealTezosSignerConfig = {}) {
    let kp: TezosKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.secret) {
      kp = keypairFromSecret(cfg.secret);
    } else {
      kp = generateTezosKeypair();
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.address = kp.address;
    this.publicKey = kp.publicKey;
    this.cfg = cfg;
    this.network = cfg.network ?? "ghostnet";
  }

  /**
   * Sign a deterministic message derived from the transfer intent. Real Ed25519
   * signature over blake2b256(canonical descriptor) — Tezos hashes the operation
   * with blake2b before signing, so we mirror that. The signature is returned in
   * Tezos's native edsig base58check form (and raw hex). The production `submit`
   * hook assembles + injects the actual `transaction` operation.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    reference?: string;
    memo?: string;
  }): Promise<TezosSignResult> {
    const descriptor = canonicalTransferDescriptor({
      network: this.network,
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = blake2b(new TextEncoder().encode(descriptor), { dkLen: 32 });
    const sigBytes = ed25519.sign(msg, this.seed);
    const signatureHex = toHex(sigBytes);
    const signature = encodeEdsig(sigBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.address,
      });
      const opHash = res.opHash ?? signature;
      return {
        signature,
        signatureHex,
        opHash,
        explorerUrl: res.explorerUrl ?? this.explorerUrl(opHash),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred. The signature
    // itself is the local operation reference (no real opHash yet).
    return {
      signature,
      signatureHex,
      opHash: signature,
      explorerUrl: this.explorerUrl(signature),
    };
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address);
    }
    return 0n;
  }

  /**
   * Verify a signature this signer produced over a descriptor. Accepts either
   * an edsig-encoded string or raw hex. Useful for tests + audits.
   */
  verify(signature: string, descriptor: string): boolean {
    try {
      const sigBytes = signature.startsWith("edsig")
        ? decodeEdsig(signature)
        : hexToBytes(signature);
      const msg = blake2b(new TextEncoder().encode(descriptor), { dkLen: 32 });
      const pubkey = ed25519.getPublicKey(this.seed);
      return ed25519.verify(sigBytes, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(ref: string): string {
    const host =
      this.network === "mainnet"
        ? "https://tzkt.io"
        : "https://ghostnet.tzkt.io";
    return `${host}/${ref}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Tezos transfer. Stable
 * field ordering so the same intent always yields the same signature. Includes
 * the network so a ghostnet signature can't be replayed on mainnet.
 */
export function canonicalTransferDescriptor(fields: {
  network: "mainnet" | "ghostnet";
  from: string;
  to: string;
  amountAtomic: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `tezos-pay/v1`,
    `network=${fields.network}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
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
