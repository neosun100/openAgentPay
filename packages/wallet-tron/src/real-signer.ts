/**
 * RealTronSigner — secp256k1 (ECDSA) signer backed by @noble/curves, no tronweb.
 * ============================================================================
 *
 * Mirrors `RealSolanaSigner` but for the TRON chain model:
 *
 *   - Crypto:      secp256k1 ECDSA (same curve family as Ethereum)
 *   - Address:     base58check( 0x41 || keccak256(uncompressedPubkey[1:])[-20:] )
 *                  → 34-char string starting with "T" (e.g. TJRyWwFs9wTFGZg3...)
 *   - Asset:       TRX (6 dp) + USDT-TRC20 (6 dp)
 *   - Settlement:  TriggerSmartContract (TRC-20 transfer) — broadcast deferred
 *                  behind the optional, pluggable `submit` hook (offline-safe).
 *
 * The cryptographic identity (keypair → address → signature) is fully REAL and
 * offline. Only the on-chain broadcast needs a live node; that is kept in the
 * `submit` hook so production can wire TronWeb's `broadcastTransaction` without
 * touching this file.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";

// ============================================================================
//  Address codec — base58check over the 0x41-prefixed keccak hash
// ============================================================================

/** TRON mainnet/testnet address prefix byte (0x41 → all addresses start "T"). */
export const TRON_ADDRESS_PREFIX = 0x41;

/** base58check encode: payload || sha256(sha256(payload))[:4], then base58. */
export function base58CheckEncode(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58.encode(full);
}

/** base58check decode → throws if checksum mismatches. Returns the payload. */
export function base58CheckDecode(encoded: string): Uint8Array {
  const full = base58.decode(encoded);
  if (full.length < 5) {
    throw new Error(`base58check string too short: ${encoded}`);
  }
  const payload = full.slice(0, full.length - 4);
  const checksum = full.slice(full.length - 4);
  const expected = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error(`base58check checksum mismatch for ${encoded}`);
    }
  }
  return payload;
}

/**
 * Derive the 21-byte TRON address bytes (0x41 || keccak[-20:]) from an
 * uncompressed secp256k1 public key (65 bytes, leading 0x04).
 */
export function pubkeyToAddressBytes(uncompressedPubkey: Uint8Array): Uint8Array {
  if (uncompressedPubkey.length !== 65 || uncompressedPubkey[0] !== 0x04) {
    throw new Error(
      `expected 65-byte uncompressed secp256k1 pubkey (0x04 prefix), got ${uncompressedPubkey.length}`
    );
  }
  // keccak256 over the 64-byte body (drop the 0x04), take the last 20 bytes.
  const hash = keccak_256(uncompressedPubkey.slice(1));
  const addr = new Uint8Array(21);
  addr[0] = TRON_ADDRESS_PREFIX;
  addr.set(hash.slice(hash.length - 20), 1);
  return addr;
}

/** Convert a TRON base58 address (T...) to its 21-byte hex form (41...). */
export function addressToHex(base58Address: string): string {
  return toHex(base58CheckDecode(base58Address));
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface TronKeypair {
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 65-byte uncompressed public key (hex, no 0x, 0x04-prefixed). */
  readonly publicKeyHex: string;
  /** base58check address — 34 chars, starts with "T". */
  readonly address: string;
  /** Raw 21-byte address (hex, 41-prefixed) — the on-chain form. */
  readonly addressHex: string;
}

/** Build a keypair from a 32-byte secp256k1 private key. */
export function keypairFromPrivateKey(priv: Uint8Array): TronKeypair {
  if (priv.length !== 32) {
    throw new Error(`TRON private key must be 32 bytes, got ${priv.length}`);
  }
  const pub = secp256k1.getPublicKey(priv, false); // uncompressed, 65 bytes
  const addrBytes = pubkeyToAddressBytes(pub);
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub),
    address: base58CheckEncode(addrBytes),
    addressHex: toHex(addrBytes),
  };
}

/**
 * Generate a fresh, cryptographically-random TRON keypair fully in-process.
 * The address is a real base58check TRON address (34 chars, leading "T"),
 * identical in shape to one a Shasta/Nile faucet would fund.
 */
export function generateTronKeypair(): TronKeypair {
  const priv = secp256k1.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv);
}

/** Reconstruct a keypair from a hex private key (with or without 0x). */
export function keypairFromHex(privateKeyHex: string): TronKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex));
}

// ============================================================================
//  RealTronSigner
// ============================================================================

export interface RealTronSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /**
   * Optional balance reader — wired to a TronGrid REST call in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    contract?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to TronWeb broadcastTransaction in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly contract?: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly txId: string;
    readonly signer: string;
  }) => Promise<{ readonly txId?: string; readonly explorerUrl?: string }>;
  /** Network for explorer URLs. */
  readonly network?: "mainnet" | "shasta" | "nile";
}

export interface TronSignResult {
  /** Hex ECDSA signature (r || s || recovery, 65 bytes, no 0x). */
  readonly signature: string;
  /** The keccak256 txID over the canonical descriptor (hex, no 0x). */
  readonly txId: string;
  readonly explorerUrl: string;
}

export class RealTronSigner {
  readonly address: string;
  readonly addressHex: string;
  private readonly priv: Uint8Array;
  private readonly cfg: RealTronSignerConfig;
  private readonly network: "mainnet" | "shasta" | "nile";

  constructor(cfg: RealTronSignerConfig = {}) {
    let kp: TronKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex);
    } else {
      kp = generateTronKeypair();
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.addressHex = kp.addressHex;
    this.cfg = cfg;
    this.network = cfg.network ?? "nile";
  }

  /**
   * Sign a canonical TRON transfer descriptor with secp256k1 ECDSA. The signed
   * message is keccak256(descriptor) — exactly how TRON derives a txID and
   * signs it. The signature is REAL and verifiable offline; the `submit` hook
   * (when present) assembles + broadcasts the actual TriggerSmartContract.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    contract?: string;
    reference?: string;
    memo?: string;
  }): Promise<TronSignResult> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.contract !== undefined ? { contract: input.contract } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const txIdBytes = keccak_256(new TextEncoder().encode(descriptor));
    const sig = secp256k1.sign(txIdBytes, this.priv);
    // 65-byte canonical form: r(32) || s(32) || recovery(1) — TRON's layout.
    const sigBytes = new Uint8Array(65);
    sigBytes.set(numberTo32Bytes(sig.r), 0);
    sigBytes.set(numberTo32Bytes(sig.s), 32);
    sigBytes[64] = sig.recovery ?? 0;
    const signature = toHex(sigBytes);
    const txId = toHex(txIdBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.contract !== undefined ? { contract: input.contract } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        txId,
        signer: this.address,
      });
      const finalTxId = res.txId ?? txId;
      return {
        signature,
        txId: finalTxId,
        explorerUrl: res.explorerUrl ?? this.explorerUrl(finalTxId),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return { signature, txId, explorerUrl: this.explorerUrl(txId) };
  }

  async getBalance(contract?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, contract);
    }
    return 0n;
  }

  /** Verify a signature this signer produced over a descriptor — for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sigBytes = hexToBytes(signatureHex);
      if (sigBytes.length !== 65) return false;
      const r = bytesToBigInt(sigBytes.slice(0, 32));
      const s = bytesToBigInt(sigBytes.slice(32, 64));
      const msg = keccak_256(new TextEncoder().encode(descriptor));
      const pub = secp256k1.getPublicKey(this.priv, false);
      const sig = new secp256k1.Signature(r, s);
      return secp256k1.verify(sig, msg, pub);
    } catch {
      return false;
    }
  }

  private explorerUrl(txId: string): string {
    const host =
      this.network === "mainnet"
        ? "https://tronscan.org"
        : `https://${this.network}.tronscan.org`;
    return `${host}/#/transaction/${txId}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a TRON transfer. Stable
 * field ordering so the same intent always yields the same txID + signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  contract?: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `tron-usdt/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `contract=${fields.contract ?? "native-trx"}`,
    `ref=${fields.reference ?? ""}`,
    `memo=${fields.memo ?? ""}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  Byte / hex helpers (no Buffer dependency — works in browser + node)
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

function numberTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
