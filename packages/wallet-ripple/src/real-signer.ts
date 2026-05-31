/**
 * RealRippleSigner — Ed25519 signer for the XRP Ledger, no `ripple-keypairs`.
 * ============================================================================
 *
 * XRPL identities are Ed25519 keypairs whose *classic address* is derived as:
 *
 *   accountId = ripemd160(sha256(pubkeyPrefixed))      // 20 bytes
 *   address   = xrplBase58Check(0x00 || accountId)     // "r..." string
 *
 * where:
 *   - pubkeyPrefixed = 0xED || rawPub32   (XRPL prefixes ed25519 pubkeys with 0xED → 33 bytes)
 *   - xrplBase58Check appends sha256(sha256(versioned))[:4] as a checksum and
 *     encodes with XRPL's CUSTOM base58 dictionary (Ripple alphabet), which is
 *     NOT the standard Bitcoin base58 alphabet.
 *
 * XRPL base58 dictionary (a.k.a. "rpp" / "ripple" alphabet):
 *     rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz
 * vs. Bitcoin's:
 *     123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
 *
 * The seed is encoded with a "family seed" version byte (0x21) → "s..." strings
 * (16-byte entropy). For our purposes we keep the full 32-byte Ed25519 seed in
 * hex and also expose the XRPL family-seed "s..." form for parity with tooling.
 *
 * Why hand-roll instead of using ripple-keypairs / xrpl.js?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (keypair → "r..." address → signature) is fully
 *     real here; only the rippled `submit` needs a live network. We keep that
 *     pluggable via the optional `submit` hook so production can wire xrpl.js's
 *     `client.submitAndWait` without touching this file.
 *
 * The signature is a real Ed25519 signature over a canonical transfer
 * descriptor — verifiable with the public key. Cross-check via `verify()`.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/legacy";

import type { RippleSigner } from "./connector.js";

// ============================================================================
//  XRPL custom base58 alphabet + version bytes
// ============================================================================

/** Ripple's CUSTOM base58 dictionary — NOT standard base58. */
export const XRPL_ALPHABET =
  "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/** Classic account address version byte → "r..." */
const VERSION_ACCOUNT_ID = 0x00;
/** Family seed version byte → "s..." (16-byte entropy). */
const VERSION_FAMILY_SEED = 0x21;
/** XRPL prefixes ed25519 public keys with 0xED to make them 33 bytes. */
const ED25519_PUBKEY_PREFIX = 0xed;

// Precompute reverse lookup for decode.
const XRPL_ALPHABET_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < XRPL_ALPHABET.length; i++) {
    m[XRPL_ALPHABET[i]!] = i;
  }
  return m;
})();

// ============================================================================
//  base58 (custom alphabet) — big-integer base conversion
// ============================================================================

/** Encode raw bytes → base58 using the XRPL alphabet (leading-zero aware). */
export function base58Encode(bytes: Uint8Array): string {
  // Count leading zero bytes — each maps to the alphabet's 0th char ("r").
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert the big-endian byte array to base58 via repeated division.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let i = 0; i < zeros; i++) out += XRPL_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) out += XRPL_ALPHABET[digits[i]!];
  return out;
}

/** Decode an XRPL-alphabet base58 string → raw bytes (leading-zero aware). */
export function base58Decode(str: string): Uint8Array {
  if (typeof str !== "string" || str.length === 0) {
    throw new Error("base58Decode: input must be a non-empty string");
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === XRPL_ALPHABET[0]) zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const ch = str[i]!;
    const val = XRPL_ALPHABET_MAP[ch];
    if (val === undefined) {
      throw new Error(`base58Decode: invalid character '${ch}'`);
    }
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  // leading zeros already 0 by Uint8Array init
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i]!;
  }
  return out;
}

// ============================================================================
//  base58check (XRPL flavor) — double-sha256 4-byte checksum
// ============================================================================

/** Encode `payload` under `version` with a 4-byte double-sha256 checksum. */
export function base58CheckEncode(version: number, payload: Uint8Array): string {
  const versioned = new Uint8Array(1 + payload.length);
  versioned[0] = version & 0xff;
  versioned.set(payload, 1);
  const checksum = sha256(sha256(versioned)).slice(0, 4);
  const full = new Uint8Array(versioned.length + 4);
  full.set(versioned, 0);
  full.set(checksum, versioned.length);
  return base58Encode(full);
}

/**
 * Decode an XRPL base58check string → { version, payload }, verifying checksum.
 * Throws on malformed input or checksum mismatch.
 */
export function base58CheckDecode(str: string): {
  version: number;
  payload: Uint8Array;
} {
  const full = base58Decode(str);
  if (full.length < 5) {
    throw new Error(`base58Check too short (${full.length} bytes)`);
  }
  const versioned = full.slice(0, full.length - 4);
  const checksum = full.slice(full.length - 4);
  const expected = sha256(sha256(versioned)).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error("base58Check checksum mismatch");
    }
  }
  return { version: versioned[0]!, payload: versioned.slice(1) };
}

// ============================================================================
//  Address / seed codecs
// ============================================================================

/** Derive the 20-byte XRPL accountId from a raw 32-byte Ed25519 public key. */
export function accountIdFromPubkey(rawPub32: Uint8Array): Uint8Array {
  if (rawPub32.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${rawPub32.length}`);
  }
  const prefixed = new Uint8Array(33);
  prefixed[0] = ED25519_PUBKEY_PREFIX;
  prefixed.set(rawPub32, 1);
  return ripemd160(sha256(prefixed));
}

/** Encode a 20-byte accountId as a classic XRPL address ("r..."). */
export function encodeAddress(accountId: Uint8Array): string {
  if (accountId.length !== 20) {
    throw new Error(`accountId must be 20 bytes, got ${accountId.length}`);
  }
  return base58CheckEncode(VERSION_ACCOUNT_ID, accountId);
}

/** Decode a classic XRPL address ("r...") back to the 20-byte accountId. */
export function decodeAddress(address: string): Uint8Array {
  const { version, payload } = base58CheckDecode(address);
  if (version !== VERSION_ACCOUNT_ID) {
    throw new Error(
      `Not an XRPL classic address (expected version 0x${VERSION_ACCOUNT_ID.toString(
        16
      )}, got 0x${version.toString(16)})`
    );
  }
  if (payload.length !== 20) {
    throw new Error(`accountId payload must be 20 bytes, got ${payload.length}`);
  }
  return payload;
}

/** Encode a 16-byte entropy as an XRPL family seed ("s..."). */
export function encodeSeed(entropy16: Uint8Array): string {
  if (entropy16.length !== 16) {
    throw new Error(`family seed entropy must be 16 bytes, got ${entropy16.length}`);
  }
  return base58CheckEncode(VERSION_FAMILY_SEED, entropy16);
}

/** Decode an XRPL family seed ("s...") back to the 16-byte entropy. */
export function decodeSeed(seed: string): Uint8Array {
  const { version, payload } = base58CheckDecode(seed);
  if (version !== VERSION_FAMILY_SEED) {
    throw new Error(
      `Not an XRPL family seed (expected version 0x${VERSION_FAMILY_SEED.toString(
        16
      )}, got 0x${version.toString(16)})`
    );
  }
  if (payload.length !== 16) {
    throw new Error(`family seed payload must be 16 bytes, got ${payload.length}`);
  }
  return payload;
}

/** True iff `s` looks like a valid XRPL classic address ("r...", checksum ok). */
export function isValidAddress(s: string): boolean {
  try {
    decodeAddress(s);
    return s.startsWith("r");
  } catch {
    return false;
  }
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface RippleKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x) — the canonical private material here. */
  readonly secretSeedHex: string;
  /** XRPL family seed ("s...") derived from the first 16 bytes — tooling parity. */
  readonly familySeed: string;
  /** XRPL ed25519 public key, prefixed (0xED || raw32), hex — 33 bytes. */
  readonly publicKeyHex: string;
  /** Classic XRPL address ("r...") — the on-chain account. */
  readonly address: string;
}

/**
 * Generate a fresh, cryptographically-random XRPL keypair.
 * The address is a real classic "r..." address, identical in shape to what a
 * testnet faucet would fund.
 */
export function generateRippleKeypair(): RippleKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Build a keypair from a 32-byte raw Ed25519 seed. */
export function keypairFromSeed(seed: Uint8Array): RippleKeypair {
  if (seed.length !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  const rawPub = ed25519.getPublicKey(seed);
  const accountId = accountIdFromPubkey(rawPub);
  const prefixedPub = new Uint8Array(33);
  prefixedPub[0] = ED25519_PUBKEY_PREFIX;
  prefixedPub.set(rawPub, 1);
  return {
    secretSeedHex: toHex(seed),
    familySeed: encodeSeed(seed.slice(0, 16)),
    publicKeyHex: toHex(prefixedPub),
    address: encodeAddress(accountId),
  };
}

/** Load a keypair from a 32-byte seed hex string. */
export function keypairFromSeedHex(seedHex: string): RippleKeypair {
  return keypairFromSeed(hexToBytes(seedHex));
}

// ============================================================================
//  RealRippleSigner
// ============================================================================

export interface RealRippleSignerConfig {
  /** Raw 32-byte Ed25519 seed. */
  readonly seed?: Uint8Array;
  /** Or a 32-byte seed hex string. */
  readonly seedHex?: string;
  /**
   * Optional balance reader — wired to a rippled / Mirror REST endpoint in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: string, currency?: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to xrpl.js submitAndWait in production.
   * If omitted, signAndSubmit() returns the locally-computed signature without
   * hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly currency?: string;
    readonly destinationTag?: string;
    readonly signatureHex: string;
    readonly publicKeyHex: string;
    readonly signer: string;
  }) => Promise<{
    readonly hash?: string;
    readonly ledgerIndex?: number;
    readonly explorerUrl?: string;
  }>;
  /** Network for explorer URLs + signing domain separation. */
  readonly network?: "mainnet" | "testnet" | "devnet";
}

export class RealRippleSigner implements RippleSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealRippleSignerConfig;
  private readonly network: "mainnet" | "testnet" | "devnet";

  constructor(cfg: RealRippleSignerConfig = {}) {
    let kp: RippleKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.seedHex) {
      kp = keypairFromSeedHex(cfg.seedHex);
    } else {
      kp = generateRippleKeypair();
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Sign a deterministic message derived from the XRPL Payment intent.
   * Real Ed25519 signature over the canonical descriptor (network-separated).
   * The production `submit` hook assembles + broadcasts the actual rippled
   * transaction; the signature here is the agent's cryptographic authorization,
   * returned hex (XRPL signatures are conventionally uppercase hex).
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    currency?: string;
    destinationTag?: string;
  }): Promise<{
    signatureHex: string;
    publicKeyHex: string;
    hash?: string;
    ledgerIndex?: number;
    explorerUrl?: string;
  }> {
    const descriptor = canonicalTransferDescriptor({
      network: this.network,
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.destinationTag !== undefined
        ? { destinationTag: input.destinationTag }
        : {}),
    });
    const msg = sha256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signatureHex = toHex(sigBytes).toUpperCase();

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.destinationTag !== undefined
          ? { destinationTag: input.destinationTag }
          : {}),
        signatureHex,
        publicKeyHex: this.publicKeyHex,
        signer: this.address,
      });
      return {
        signatureHex,
        publicKeyHex: this.publicKeyHex,
        ...(res.hash !== undefined ? { hash: res.hash } : {}),
        ...(res.ledgerIndex !== undefined ? { ledgerIndex: res.ledgerIndex } : {}),
        explorerUrl: res.explorerUrl ?? this.explorerUrl(res.hash ?? signatureHex),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred. We surface
    // the signature itself as the local reference (no real tx hash yet).
    return {
      signatureHex,
      publicKeyHex: this.publicKeyHex,
      explorerUrl: this.explorerUrl(signatureHex),
    };
  }

  async getBalance(currency?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, currency);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msg = sha256(new TextEncoder().encode(descriptor));
      const rawPub = ed25519.getPublicKey(this.seed);
      return ed25519.verify(sig, msg, rawPub);
    } catch {
      return false;
    }
  }

  private explorerUrl(ref: string): string {
    const host =
      this.network === "mainnet"
        ? "livenet.xrpl.org"
        : this.network === "devnet"
          ? "devnet.xrpl.org"
          : "testnet.xrpl.org";
    return `https://${host}/transactions/${ref}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of an XRPL Payment.
 * Stable field ordering so the same intent always yields the same signature.
 * Includes the network so a testnet signature can't be replayed on mainnet.
 */
export function canonicalTransferDescriptor(fields: {
  network: "mainnet" | "testnet" | "devnet";
  from: string;
  to: string;
  amountAtomic: string;
  currency?: string;
  destinationTag?: string;
}): string {
  const parts = [
    `xrpl-payment/v1`,
    `network=${fields.network}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `currency=${fields.currency ?? "XRP"}`,
    `destinationTag=${fields.destinationTag ?? ""}`,
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
