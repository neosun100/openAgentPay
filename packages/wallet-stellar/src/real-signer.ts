/**
 * RealStellarSigner — Ed25519 signer backed by @noble/curves, no stellar-sdk.
 * ============================================================================
 *
 * Stellar identities are Ed25519 keypairs encoded as "StrKey" (SEP-23):
 *
 *   - Public key  → version byte 6<<3 = 0x30  → base32 → starts with "G", 56 chars
 *   - Secret seed → version byte 18<<3 = 0x90 → base32 → starts with "S", 56 chars
 *
 * StrKey layout:  [1-byte version] [payload] [2-byte CRC16-XModem checksum (LE)]
 *   then RFC-4648 base32 (no padding) over the whole 35-byte buffer (1+32+2).
 *
 * Why not stellar-sdk?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (keypair → StrKey address → signature) is fully
 *     real here; only the Horizon *submit* needs a live network. We keep that
 *     pluggable via the optional `submit` hook so production can wire
 *     stellar-sdk's `server.submitTransaction` without changing this file.
 *
 * The signature is a real Ed25519 signature over a canonical SEP-10-ish transfer
 * descriptor — verifiable with the public key. Cross-check via `verify()`.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { base32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";

import type { StellarSigner } from "./connector.js";

// ============================================================================
//  StrKey version bytes (SEP-23)
// ============================================================================

/** ed25519 public key:  6 << 3 = 0x30 → "G" */
const VERSION_BYTE_ACCOUNT_ID = 6 << 3; // 0x30
/** ed25519 secret seed: 18 << 3 = 0x90 → "S" */
const VERSION_BYTE_SEED = 18 << 3; // 0x90

// ============================================================================
//  CRC16-XModem (poly 0x1021, init 0x0000) — hand-rolled, no dep
// ============================================================================

/**
 * CRC16-XModem checksum over `data`. Returns the 16-bit value as a number.
 * Stellar appends it little-endian after the payload before base32.
 */
export function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i]! << 8) & 0xffff;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

// ============================================================================
//  StrKey encode / decode
// ============================================================================

/** Encode a raw payload under a StrKey version byte → base32 (no padding). */
export function strkeyEncode(versionByte: number, payload: Uint8Array): string {
  const data = new Uint8Array(1 + payload.length);
  data[0] = versionByte & 0xff;
  data.set(payload, 1);

  const checksum = crc16xmodem(data);
  const full = new Uint8Array(data.length + 2);
  full.set(data, 0);
  // little-endian checksum
  full[data.length] = checksum & 0xff;
  full[data.length + 1] = (checksum >> 8) & 0xff;

  // RFC-4648 base32, Stellar emits NO padding.
  return base32.encode(full).replace(/=+$/, "");
}

/**
 * Decode a StrKey string → { versionByte, payload }. Verifies the CRC16.
 * Throws on malformed input or checksum mismatch.
 */
export function strkeyDecode(strkey: string): {
  versionByte: number;
  payload: Uint8Array;
} {
  if (typeof strkey !== "string" || strkey.length === 0) {
    throw new Error("StrKey must be a non-empty string");
  }
  // @scure/base base32 requires correct padding to a multiple of 8 chars.
  const padLen = (8 - (strkey.length % 8)) % 8;
  const padded = strkey + "=".repeat(padLen);
  let full: Uint8Array;
  try {
    full = base32.decode(padded);
  } catch (e) {
    throw new Error(`StrKey is not valid base32: ${(e as Error).message}`);
  }
  if (full.length < 3) {
    throw new Error(`StrKey too short (${full.length} bytes)`);
  }
  const versionByte = full[0]!;
  const payload = full.slice(1, full.length - 2);
  const data = full.slice(0, full.length - 2);
  const expected = crc16xmodem(data);
  const actual = full[full.length - 2]! | (full[full.length - 1]! << 8);
  if (expected !== actual) {
    throw new Error("StrKey checksum mismatch");
  }
  return { versionByte, payload };
}

/** Encode a 32-byte Ed25519 public key as a Stellar account id ("G..."). */
export function encodeAccountId(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) {
    throw new Error(`Stellar public key must be 32 bytes, got ${pubkey.length}`);
  }
  return strkeyEncode(VERSION_BYTE_ACCOUNT_ID, pubkey);
}

/** Encode a 32-byte Ed25519 seed as a Stellar secret seed ("S..."). */
export function encodeSeed(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`Stellar seed must be 32 bytes, got ${seed.length}`);
  }
  return strkeyEncode(VERSION_BYTE_SEED, seed);
}

/** Decode a "G..." account id back to the 32-byte raw public key. */
export function decodeAccountId(address: string): Uint8Array {
  const { versionByte, payload } = strkeyDecode(address);
  if (versionByte !== VERSION_BYTE_ACCOUNT_ID) {
    throw new Error(
      `Not a Stellar account id (expected version 0x${VERSION_BYTE_ACCOUNT_ID.toString(
        16
      )}, got 0x${versionByte.toString(16)})`
    );
  }
  if (payload.length !== 32) {
    throw new Error(`Account id payload must be 32 bytes, got ${payload.length}`);
  }
  return payload;
}

/** Decode an "S..." secret seed back to the 32-byte raw seed. */
export function decodeSeed(secret: string): Uint8Array {
  const { versionByte, payload } = strkeyDecode(secret);
  if (versionByte !== VERSION_BYTE_SEED) {
    throw new Error(
      `Not a Stellar secret seed (expected version 0x${VERSION_BYTE_SEED.toString(
        16
      )}, got 0x${versionByte.toString(16)})`
    );
  }
  if (payload.length !== 32) {
    throw new Error(`Seed payload must be 32 bytes, got ${payload.length}`);
  }
  return payload;
}

/** True iff `s` looks like a valid Stellar account id ("G...", 56 chars, CRC ok). */
export function isValidAccountId(s: string): boolean {
  try {
    decodeAccountId(s);
    return s.startsWith("G") && s.length === 56;
  } catch {
    return false;
  }
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface StellarKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly secretSeedHex: string;
  /** StrKey secret seed ("S...", 56 chars) — the form `stellar-keygen` emits. */
  readonly secret: string;
  /** StrKey account id ("G...", 56 chars) — the on-chain address. */
  readonly address: string;
}

/**
 * Generate a fresh, cryptographically-random Stellar keypair.
 * The address is a real StrKey account id, identical in shape to what a
 * testnet Friendbot would fund.
 */
export function generateStellarKeypair(): StellarKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Build a keypair from a 32-byte raw Ed25519 seed. */
export function keypairFromSeed(seed: Uint8Array): StellarKeypair {
  if (seed.length !== 32) {
    throw new Error(`Stellar seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  return {
    secretSeedHex: toHex(seed),
    secret: encodeSeed(seed),
    address: encodeAccountId(pubkey),
  };
}

/** Load a keypair from a StrKey secret ("S..."). */
export function keypairFromSecret(secret: string): StellarKeypair {
  return keypairFromSeed(decodeSeed(secret));
}

// ============================================================================
//  RealStellarSigner
// ============================================================================

export interface RealStellarSignerConfig {
  /** StrKey secret seed ("S..."). */
  readonly secret?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /**
   * Optional balance reader — wired to a Horizon REST endpoint in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    assetCode?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to stellar-sdk submitTransaction in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly assetCode?: string;
    readonly assetIssuer?: string;
    readonly memo?: string;
    readonly signatureHex: string;
    readonly signer: string;
  }) => Promise<{ readonly hash?: string; readonly ledger?: number; readonly explorerUrl?: string }>;
  /** Network for explorer URLs + signing domain separation. */
  readonly network?: "public" | "testnet";
}

export class RealStellarSigner implements StellarSigner {
  readonly address: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealStellarSignerConfig;
  private readonly network: "public" | "testnet";

  constructor(cfg: RealStellarSignerConfig = {}) {
    let kp: StellarKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.secret) {
      kp = keypairFromSecret(cfg.secret);
    } else {
      kp = generateStellarKeypair();
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.address = kp.address;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Sign a deterministic message derived from the SEP-31 transfer intent.
   * Real Ed25519 signature over the canonical descriptor (network-separated).
   * The production `submit` hook assembles + broadcasts the actual Horizon
   * transaction; the signature here is the agent's cryptographic authorization,
   * returned hex (Stellar signatures are 64 bytes, conventionally hex/base64).
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    assetCode?: string;
    assetIssuer?: string;
    memo?: string;
  }): Promise<{ signatureHex: string; hash?: string; ledger?: number; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      network: this.network,
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.assetCode !== undefined ? { assetCode: input.assetCode } : {}),
      ...(input.assetIssuer !== undefined ? { assetIssuer: input.assetIssuer } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = sha256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signatureHex = toHex(sigBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.assetCode !== undefined ? { assetCode: input.assetCode } : {}),
        ...(input.assetIssuer !== undefined ? { assetIssuer: input.assetIssuer } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signatureHex,
        signer: this.address,
      });
      return {
        signatureHex,
        ...(res.hash !== undefined ? { hash: res.hash } : {}),
        ...(res.ledger !== undefined ? { ledger: res.ledger } : {}),
        explorerUrl: res.explorerUrl ?? this.explorerUrl(res.hash ?? signatureHex),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred. We surface
    // the signature itself as the local reference (no real tx hash yet).
    return {
      signatureHex,
      explorerUrl: this.explorerUrl(signatureHex),
    };
  }

  async getBalance(assetCode?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, assetCode);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msg = sha256(new TextEncoder().encode(descriptor));
      const pubkey = decodeAccountId(this.address);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(ref: string): string {
    const net = this.network === "public" ? "public" : "testnet";
    return `https://stellar.expert/explorer/${net}/tx/${ref}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a SEP-31 transfer.
 * Stable field ordering so the same intent always yields the same signature.
 * Includes the network so a testnet signature can't be replayed on mainnet.
 */
export function canonicalTransferDescriptor(fields: {
  network: "public" | "testnet";
  from: string;
  to: string;
  amountAtomic: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
}): string {
  const parts = [
    `stellar-sep31/v1`,
    `network=${fields.network}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `asset=${fields.assetCode ?? "XLM"}`,
    `issuer=${fields.assetIssuer ?? "native"}`,
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
