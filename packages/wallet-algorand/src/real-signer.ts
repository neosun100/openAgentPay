/**
 * RealAlgorandSigner — Ed25519 signer backed by @noble/curves, no algosdk.
 * ============================================================================
 *
 * Algorand identity model (mirrors what Pera/Defly wallets display):
 *   - 32-byte Ed25519 keypair.
 *   - Address = base32(pubkey || sha512_256(pubkey)[-4:]) with NO padding,
 *     uppercased — exactly 58 chars. (Algorand "checksum address" spec.)
 *   - Signatures are raw 64-byte Ed25519, conventionally base64 on-wire; we
 *     return base64 here (Algorand's `sig` field form).
 *
 * Why not algosdk?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (keypair → address → signature) is fully real
 *     here; only the algod *broadcast* needs a live node. We keep that
 *     pluggable via the optional `submit` hook so production can wire
 *     algosdk's `sendRawTransaction` without changing this file.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha512_256 } from "@noble/hashes/sha2";
import { base32nopad, base64 } from "@scure/base";

import type { AlgorandSigner } from "./connector.js";

// ============================================================================
//  Address codec (Algorand checksum address)
// ============================================================================

const ALGO_PUBKEY_LEN = 32;
const ALGO_CHECKSUM_LEN = 4;
const ALGO_ADDRESS_LEN = 58;

/**
 * Encode a 32-byte Ed25519 public key into a canonical Algorand address:
 *   base32_nopad( pubkey(32) || sha512_256(pubkey)[-4:] ).toUpperCase()
 */
export function encodeAlgorandAddress(pubkey: Uint8Array): string {
  if (pubkey.length !== ALGO_PUBKEY_LEN) {
    throw new Error(`Algorand pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  const checksum = sha512_256(pubkey).slice(-ALGO_CHECKSUM_LEN);
  const payload = new Uint8Array(ALGO_PUBKEY_LEN + ALGO_CHECKSUM_LEN);
  payload.set(pubkey, 0);
  payload.set(checksum, ALGO_PUBKEY_LEN);
  // @scure base32 uses RFC4648 uppercase alphabet; nopad strips "=".
  return base32nopad.encode(payload);
}

/**
 * Decode + validate an Algorand address back into its 32-byte public key.
 * Verifies length (58), and that the trailing 4-byte checksum matches
 * sha512_256(pubkey)[-4:]. Throws on any mismatch.
 */
export function decodeAlgorandAddress(address: string): Uint8Array {
  if (address.length !== ALGO_ADDRESS_LEN) {
    throw new Error(
      `Algorand address must be ${ALGO_ADDRESS_LEN} chars, got ${address.length}`
    );
  }
  if (address !== address.toUpperCase()) {
    throw new Error("Algorand address must be uppercase base32");
  }
  const decoded = base32nopad.decode(address);
  if (decoded.length !== ALGO_PUBKEY_LEN + ALGO_CHECKSUM_LEN) {
    throw new Error(
      `Algorand address decodes to ${decoded.length} bytes, expected ${ALGO_PUBKEY_LEN + ALGO_CHECKSUM_LEN}`
    );
  }
  const pubkey = decoded.slice(0, ALGO_PUBKEY_LEN);
  const checksum = decoded.slice(ALGO_PUBKEY_LEN);
  const expected = sha512_256(pubkey).slice(-ALGO_CHECKSUM_LEN);
  for (let i = 0; i < ALGO_CHECKSUM_LEN; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error("Algorand address checksum mismatch");
    }
  }
  return pubkey;
}

/** True iff `address` is a structurally valid Algorand checksum address. */
export function isValidAlgorandAddress(address: string): boolean {
  try {
    decodeAlgorandAddress(address);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface AlgorandKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly secretSeedHex: string;
  /** 32-byte public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** Canonical 58-char uppercase Algorand address. */
  readonly address: string;
}

/**
 * Generate a fresh, cryptographically-random Algorand keypair.
 * The address is a real 58-char base32 checksum address, identical in shape
 * to what a TestNet dispenser would fund.
 */
export function generateAlgorandKeypair(): AlgorandKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Reconstruct a keypair from a 32-byte Ed25519 seed. */
export function keypairFromSeed(seed: Uint8Array): AlgorandKeypair {
  if (seed.length !== 32) {
    throw new Error(`Algorand seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  return {
    secretSeedHex: toHex(seed),
    publicKeyHex: toHex(pubkey),
    address: encodeAlgorandAddress(pubkey),
  };
}

/** Load a keypair from a 32-byte seed encoded as hex (with/without 0x). */
export function keypairFromHex(seedHex: string): AlgorandKeypair {
  return keypairFromSeed(hexToBytes(seedHex));
}

// ============================================================================
//  RealAlgorandSigner
// ============================================================================

export interface RealAlgorandSignerConfig {
  /** Supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /** Or a 32-byte seed as hex (with/without 0x). */
  readonly secretSeedHex?: string;
  /**
   * Optional balance reader — wired to an algod/indexer REST endpoint in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    assetId?: number
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to algosdk `sendRawTransaction` in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly assetId?: number;
    readonly note?: string;
    readonly signatureB64: string;
    readonly signer: string;
  }) => Promise<{ readonly txId?: string; readonly round?: number }>;
  /** Network for explorer/txn-ref context. */
  readonly network?: "mainnet" | "testnet" | "betanet";
}

export class RealAlgorandSigner implements AlgorandSigner {
  readonly address: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealAlgorandSignerConfig;
  private readonly network: "mainnet" | "testnet" | "betanet";

  constructor(cfg: RealAlgorandSignerConfig = {}) {
    let kp: AlgorandKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.secretSeedHex) {
      kp = keypairFromHex(cfg.secretSeedHex);
    } else {
      kp = generateAlgorandKeypair();
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.address = kp.address;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Produce a REAL Ed25519 signature over the canonical Algorand transfer
   * descriptor. The production `submit` hook is responsible for assembling +
   * broadcasting the actual msgpack transaction; the signature here is the
   * agent's cryptographic authorization, returned base64 (Algorand's `sig`
   * field form).
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    assetId?: number;
    note?: string;
  }): Promise<{ signatureB64: string; txId?: string; round?: number }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    const msg = new TextEncoder().encode(descriptor);
    const sigBytes = ed25519.sign(msg, this.seed);
    const signatureB64 = base64.encode(sigBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        signatureB64,
        signer: this.address,
      });
      return {
        signatureB64,
        ...(res.txId !== undefined ? { txId: res.txId } : {}),
        ...(res.round !== undefined ? { round: res.round } : {}),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    // Deterministic mock txId derived from the (real) signature.
    return {
      signatureB64,
      txId: mockTxId(signatureB64),
      round: 0,
    };
  }

  async getBalance(assetId?: number): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, assetId);
    }
    return 0n;
  }

  /**
   * Verify a base64 signature this signer produced over `descriptor`.
   * Useful for tests + audits. Returns false on any malformed input.
   */
  verify(signatureB64: string, descriptor: string): boolean {
    try {
      const sig = base64.decode(signatureB64);
      const msg = new TextEncoder().encode(descriptor);
      const pubkey = decodeAlgorandAddress(this.address);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  get networkName(): string {
    return this.network;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of an Algorand transfer.
 * Stable field ordering so the same intent always yields the same signature.
 * (Production replaces this with the canonical msgpack txn; this offline form
 * is sufficient to prove cryptographic authorization end-to-end.)
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  assetId?: number;
  note?: string;
}): string {
  const parts = [
    `algorand-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `asset=${fields.assetId !== undefined ? fields.assetId : "ALGO"}`,
    `note=${fields.note ?? ""}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  Helpers (no Buffer dependency — works in browser + node)
// ============================================================================

/** Deterministic 52-char base32 txId-like ref from a base64 signature. */
function mockTxId(signatureB64: string): string {
  const digest = sha512_256(new TextEncoder().encode(signatureB64));
  // Algorand txIds are 52-char uppercase base32 (32-byte sha512_256, nopad).
  return base32nopad.encode(digest);
}

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
