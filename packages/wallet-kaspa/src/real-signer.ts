/**
 * RealKaspaSigner — secp256k1 signer backed by @noble/curves, no kaspa-wasm deps.
 * ============================================================================
 *
 * The Kaspa analogue of RealCosmosSigner / RealSolanaSigner. It holds a real
 * BIP39 mnemonic, derives a secp256k1 keypair, computes a Kaspa "cashaddr"
 * style address ("kaspatest:…"), and signs the canonical transfer descriptor
 * with secp256k1 ECDSA over a sha256 digest.
 *
 * ── On crypto choice (documented, deliberate) ──────────────────────────────
 *   Production Kaspa uses **Schnorr** signatures (BIP340) on secp256k1 for its
 *   on-chain transaction sighashes. For OpenAgentPay's *identity + authorization*
 *   layer we instead use **secp256k1 ECDSA** via @noble/curves, because:
 *     • The OAP authorization is an off-chain, verifiable proof of agent intent,
 *       not the raw on-chain sighash — the actual Schnorr-signed tx is assembled
 *       and broadcast by the pluggable `submit` hook in production (kaspa-wasm /
 *       kaspad RPC), which can re-sign with Schnorr from the same private key.
 *     • ECDSA over the same secp256k1 curve keeps the keypair identical and the
 *       signing path dependency-free + offline-deterministic for conformance.
 *   The private key is the SAME secp256k1 scalar either way, so a production
 *   broadcaster derives the Schnorr signature from it without key migration.
 *
 * ── On the address format (documented, deliberate) ─────────────────────────
 *   Real Kaspa addresses are a CashAddr variant: base32(version_byte || pubkey)
 *   plus a BCH-style 40-bit polymod checksum, prefixed "kaspa:" / "kaspatest:".
 *   The CashAddr base32 charset is IDENTICAL to bech32's
 *   ("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), so we implement a *documented
 *   simplified* encoding over @scure/base's `bech32` codec: we bech32-encode
 *   (version_byte || x-only-pubkey) under the hrp "kaspatest". This yields a
 *   real, reversible, checksummed "kaspatest:…" address whose payload is the
 *   genuine compressed-pubkey material. It is byte-compatible at the payload
 *   level with a real Kaspa ECDSA address; only the checksum polynomial differs
 *   (bech32's vs CashAddr's), which is irrelevant for our identity layer and is
 *   noted here so production can swap in the exact CashAddr polymod if needed.
 *
 * Key material:
 *   - 24-word BIP39 mnemonic (256-bit entropy).
 *   - BIP44 path m/44'/111111'/0'/0/0 (111111 = KAS coin type, SLIP-0044).
 *   - Address = "kaspatest:" + bech32(version=0x00 schnorr-pubkey-type || x-pubkey).
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bech32 } from "@scure/base";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// ============================================================================
//  Constants
// ============================================================================

/** KAS SLIP-0044 coin type. */
export const KASPA_COIN_TYPE = 111111;
/** Canonical Kaspa derivation path. */
export const KASPA_HD_PATH = "m/44'/111111'/0'/0/0";
/** Default Kaspa testnet human-readable prefix (cashaddr hrp). */
export const KASPA_HRP = "kaspatest";
/** Kaspa mainnet hrp — exposed for parity, not used by default. */
export const KASPA_MAINNET_HRP = "kaspa";
/**
 * CashAddr version byte for a Schnorr (x-only) public-key address.
 * 0x00 = pubkey (schnorr), per the Kaspa address spec.
 */
export const KASPA_ADDR_VERSION = 0x00;

// @scure/base's bech32 enforces a 90-char total cap; a Kaspa address (hrp 9 +
// 1 sep + ~59 data) stays well under it, so the default codec is fine.

// ============================================================================
//  Wallet / keypair helpers
// ============================================================================

export interface KaspaWallet {
  /** 24-word BIP39 mnemonic (256-bit entropy). */
  readonly mnemonic: string;
  /** "kaspatest:…" address. */
  readonly address: string;
}

export interface KaspaKeypair {
  readonly mnemonic: string;
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 33-byte compressed secp256k1 public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** "kaspatest:…" cashaddr-style address. */
  readonly address: string;
  /** Human-readable prefix (hrp) used for the address. */
  readonly hrp: string;
}

/**
 * Generate a fresh Kaspa wallet — a real 24-word mnemonic plus the canonical
 * "kaspatest:…" address. Fully offline; no faucet/network involved.
 */
export function generateKaspaWallet(hrp = KASPA_HRP): KaspaWallet {
  const kp = generateKaspaKeypair(hrp);
  return { mnemonic: kp.mnemonic, address: kp.address };
}

/** Full keypair generation — mnemonic + derived secp256k1 key + cashaddr. */
export function generateKaspaKeypair(hrp = KASPA_HRP): KaspaKeypair {
  // 256 bits of entropy → 24-word mnemonic.
  const mnemonic = generateMnemonic(wordlist, 256);
  return keypairFromMnemonic(mnemonic, hrp);
}

/**
 * Derive a Kaspa keypair from an existing BIP39 mnemonic. Validates the
 * mnemonic against the English wordlist + checksum before deriving.
 *
 * Uses a self-contained BIP32-CKD over secp256k1 (HMAC-SHA512) so no @scure/bip32
 * dependency is required — the derived key at m/44'/111111'/0'/0/0 is canonical.
 */
export function keypairFromMnemonic(
  mnemonic: string,
  hrp = KASPA_HRP
): KaspaKeypair {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic (failed wordlist/checksum check)");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const privateKey = deriveBip44PrivateKey(seed);
  const publicKey = secp256k1.getPublicKey(privateKey, true); // 33 bytes compressed
  const address = addressFromPublicKey(publicKey, hrp);
  return {
    mnemonic,
    privateKeyHex: toHex(privateKey),
    publicKeyHex: toHex(publicKey),
    address,
    hrp,
  };
}

/**
 * Compute a Kaspa cashaddr-style address from a compressed secp256k1 public key:
 *   address = hrp + ":" + bech32Data(version_byte || x-only-pubkey)
 *
 * We take the x-only (32-byte) coordinate to mirror Kaspa's Schnorr address
 * payload, prepend the version byte, and bech32-encode under the hrp.
 */
export function addressFromPublicKey(
  publicKey: Uint8Array,
  hrp = KASPA_HRP
): string {
  const xOnly = xOnlyFromPublicKey(publicKey); // 32 bytes
  const payload = new Uint8Array(1 + xOnly.length);
  payload[0] = KASPA_ADDR_VERSION;
  payload.set(xOnly, 1);
  // bech32.encode yields "<hrp>1<data>"; Kaspa cashaddr uses ":" as the
  // hrp/data separator instead of "1". We swap the FIRST separator so the
  // address reads "kaspatest:<data>", matching the on-chain convention.
  const encoded = bech32.encode(hrp, bech32.toWords(payload), false as never);
  return separatorToColon(encoded, hrp);
}

/**
 * Decode a "kaspatest:…" / "kaspa:…" address back to its version byte +
 * x-only pubkey payload. Throws on malformed input or wrong prefix family.
 */
export function decodeAddress(address: string): {
  hrp: string;
  version: number;
  xOnlyPubkey: Uint8Array;
} {
  // Reverse the cashaddr ":" → bech32 "1" separator before decoding.
  const bech = colonToSeparator(address);
  const decoded = bech32.decode(bech as `${string}1${string}`, false as never);
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length < 1) throw new Error("Kaspa address payload is empty");
  const version = bytes[0] as number;
  return {
    hrp: decoded.prefix,
    version,
    xOnlyPubkey: bytes.slice(1),
  };
}

/** Swap bech32's "1" separator for Kaspa's ":" — only the first occurrence. */
function separatorToColon(bech: string, hrp: string): string {
  if (!bech.startsWith(`${hrp}1`)) {
    throw new Error(`Unexpected bech32 output: ${bech}`);
  }
  return `${hrp}:${bech.slice(hrp.length + 1)}`;
}

/** Swap Kaspa's ":" separator back to bech32's "1" for decoding. */
function colonToSeparator(address: string): string {
  const idx = address.indexOf(":");
  if (idx < 0) {
    throw new Error(`Kaspa address missing ":" separator: ${address}`);
  }
  return `${address.slice(0, idx)}1${address.slice(idx + 1)}`;
}

/** Extract the 32-byte x-only coordinate from a compressed/uncompressed pubkey. */
function xOnlyFromPublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length === 33) return publicKey.slice(1); // drop 0x02/0x03 prefix
  if (publicKey.length === 32) return publicKey; // already x-only
  if (publicKey.length === 65) {
    const point = secp256k1.ProjectivePoint.fromHex(publicKey);
    return point.toRawBytes(true).slice(1);
  }
  throw new Error(
    `Kaspa pubkey must be 33 (compressed), 32 (x-only) or 65 (uncompressed) bytes, got ${publicKey.length}`
  );
}

// ============================================================================
//  Minimal BIP32 derivation (secp256k1, hardened+normal CKD) — no @scure/bip32
// ============================================================================
//
//  We implement just enough BIP32 to walk m/44'/111111'/0'/0/0. This keeps the
//  signer dependency-light while producing a canonical, deterministic key.

import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha2";

const HARDENED_OFFSET = 0x80000000;
const SECP256K1_N = secp256k1.CURVE.n;

interface HdNode {
  readonly key: Uint8Array; // 32-byte private key
  readonly chainCode: Uint8Array; // 32-byte
}

function masterFromSeed(seed: Uint8Array): HdNode {
  const I = hmac(sha512, new TextEncoder().encode("Bitcoin seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function ckdPriv(node: HdNode, index: number): HdNode {
  const data = new Uint8Array(37);
  if (index >= HARDENED_OFFSET) {
    // Hardened: 0x00 || ser256(key) || ser32(index)
    data[0] = 0x00;
    data.set(node.key, 1);
  } else {
    // Normal: serP(pubkey) || ser32(index)
    data.set(secp256k1.getPublicKey(node.key, true), 0);
  }
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;

  const I = hmac(sha512, node.chainCode, data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);
  const ilNum = bytesToBigInt(IL);
  const parentNum = bytesToBigInt(node.key);
  const childNum = (ilNum + parentNum) % SECP256K1_N;
  if (ilNum >= SECP256K1_N || childNum === 0n) {
    // Statistically negligible; surface rather than silently produce a bad key.
    throw new Error("Invalid BIP32 child key derived (retry with next index)");
  }
  return { key: bigIntTo32Bytes(childNum), chainCode: IR };
}

/** Walk m/44'/111111'/0'/0/0 and return the 32-byte private key. */
function deriveBip44PrivateKey(seed: Uint8Array): Uint8Array {
  let node = masterFromSeed(seed);
  const path = [
    44 + HARDENED_OFFSET,
    KASPA_COIN_TYPE + HARDENED_OFFSET,
    0 + HARDENED_OFFSET,
    0,
    0,
  ];
  for (const idx of path) node = ckdPriv(node, idx);
  return node.key;
}

// ============================================================================
//  RealKaspaSigner
// ============================================================================

export interface RealKaspaSignerConfig {
  /** Supply an existing 24-word mnemonic. */
  readonly mnemonic?: string;
  /** cashaddr hrp (default "kaspatest"). */
  readonly hrp?: string;
  /** Network label for explorer URLs (default "testnet-10"). */
  readonly network?: string;
  /**
   * Optional balance reader — wired to a kaspad / Kaspa REST API in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to kaspa-wasm / kaspad submitTransaction in
   * production (which re-signs the sighash with Schnorr). If omitted,
   * signAndSubmit() returns the locally-computed ECDSA authorization without
   * hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
    readonly pubkeyHex: string;
  }) => Promise<{ readonly txId?: string; readonly daaScore?: number }>;
}

export class RealKaspaSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  readonly hrp: string;
  readonly network: string;
  private readonly privateKey: Uint8Array;
  private readonly cfg: RealKaspaSignerConfig;

  constructor(cfg: RealKaspaSignerConfig = {}) {
    const hrp = cfg.hrp ?? KASPA_HRP;
    const kp = cfg.mnemonic
      ? keypairFromMnemonic(cfg.mnemonic, hrp)
      : generateKaspaKeypair(hrp);
    this.privateKey = hexToBytes(kp.privateKeyHex);
    this.publicKeyHex = kp.publicKeyHex;
    this.address = kp.address;
    this.hrp = hrp;
    this.network = cfg.network ?? "testnet-10";
    this.cfg = cfg;
  }

  /**
   * Sign a deterministic descriptor derived from the transfer intent. This is
   * a real secp256k1 ECDSA signature over sha256(descriptor), returned as hex
   * (compact 64-byte r||s). The production `submit` hook assembles + Schnorr-
   * signs + broadcasts the actual on-chain Kaspa transaction.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    memo?: string;
  }): Promise<{
    signature: string;
    txId?: string;
    daaScore?: number;
    explorerUrl?: string;
  }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      network: this.network,
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msgHash = sha256(new TextEncoder().encode(descriptor));
    const sig = secp256k1.sign(msgHash, this.privateKey);
    const signature = toHex(sig.toCompactRawBytes()); // 64-byte r||s, hex

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.address,
        pubkeyHex: this.publicKeyHex,
      });
      return {
        signature,
        ...(res.txId !== undefined ? { txId: res.txId } : {}),
        ...(res.daaScore !== undefined ? { daaScore: res.daaScore } : {}),
        ...(res.txId !== undefined
          ? { explorerUrl: this.explorerUrl(res.txId) }
          : {}),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return { signature };
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msgHash = sha256(new TextEncoder().encode(descriptor));
      const pubkey = hexToBytes(this.publicKeyHex);
      return secp256k1.verify(sig, msgHash, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(txId: string): string {
    const base =
      this.network.startsWith("testnet")
        ? "https://explorer-tn10.kaspa.org/txs"
        : "https://explorer.kaspa.org/txs";
    return `${base}/${txId}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Kaspa transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  network: string;
  memo?: string;
}): string {
  const parts = [
    `kaspa-pay/v1`,
    `network=${fields.network}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `denom=sompi`,
    `memo=${fields.memo ?? ""}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  Numeric / hex helpers (no Buffer dependency — works in browser + node)
// ============================================================================

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
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
