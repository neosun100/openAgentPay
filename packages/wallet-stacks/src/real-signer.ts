/**
 * RealStacksSigner — secp256k1 signer + native c32check address codec.
 * ============================================================================
 *
 * Stacks is a Bitcoin L2 ("settles on Bitcoin"). Its account model and crypto:
 *
 *   - Crypto:      secp256k1 ECDSA (same curve as Bitcoin / Ethereum). Stacks
 *                  transaction signatures are RSV (recoverable, 65-byte) but a
 *                  plain canonical ECDSA signature over a sha256 digest is what
 *                  we expose here — fully verifiable offline.
 *   - Address:     c32check — Stacks' own Crockford-base32 + double-sha256
 *                  checksum codec, NOT bech32 and NOT base58check. A standard
 *                  address is:
 *                      c32check(version, ripemd160(sha256(compressed_pubkey)))
 *                  Testnet single-sig version byte = 26 (0x1a) → addresses
 *                  begin with "ST". Mainnet single-sig version = 22 (0x16) → "SP".
 *   - Asset:       STX (6 decimals, smallest unit = microSTX / µSTX).
 *   - Settlement:  signs a canonical transfer descriptor; on-chain broadcast is
 *                  deferred behind the optional, pluggable `submit` hook
 *                  (offline-safe, deterministic mock txid).
 *
 * c32check reference (Crockford alphabet, checksum scheme) mirrors the canonical
 * `c32check`/`c32address` implementation used by the Stacks ecosystem:
 *   - alphabet   = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" (Crockford base32)
 *   - checksum   = first 4 bytes of sha256(sha256(version || hash160))
 *   - c32address = version_char || c32(hash160 || checksum)
 * We implement a documented, self-contained version over @scure/base byte
 * helpers — no `@stacks/*` dependency — so signing + tests run fully offline.
 *
 * The cryptographic identity (keypair → ST… address → signature) is entirely
 * REAL and offline. Only the broadcast needs a live node; that lives in the
 * `submit` hook so production can wire a Stacks API push without touching this.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/legacy";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// ============================================================================
//  Network params
// ============================================================================

export type StacksNetwork = "testnet" | "mainnet";

/**
 * Stacks single-sig (standard P2PKH-equivalent) address version bytes.
 *   - mainnet single-sig = 22 (0x16) → "SP…"
 *   - testnet single-sig = 26 (0x1a) → "ST…"
 */
export const STACKS_VERSION = {
  mainnet: 22,
  testnet: 26,
} as const;

/** The leading character a c32-encoded address gets for each version byte. */
export function addressPrefixFor(network: StacksNetwork): "SP" | "ST" {
  return network === "mainnet" ? "SP" : "ST";
}

// ============================================================================
//  c32 (Crockford base32) low-level codec
// ============================================================================

/** Crockford base32 alphabet used by Stacks c32. */
export const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encode raw bytes to a c32 (Crockford base32) string.
 *
 * Algorithm (matches the canonical Stacks c32 codec):
 *   1. Convert the whole byte buffer (big-endian) to a base-32 digit string.
 *   2. Restore leading-zero information: every leading 0x00 byte contributes
 *      one extra leading "0" digit. The c32 spec emits exactly ceil(bits/5)
 *      "0" digits for a leading zero byte run, but the round-trippable form
 *      used here pads to a fixed width derived from the byte length so that
 *      c32decode recovers the exact original buffer. For Stacks addresses the
 *      input is always a 20-byte hash160 || 4-byte checksum, so this is
 *      deterministic and the leading-zero edge cases never lose data.
 */
export function c32encode(data: Uint8Array): string {
  if (data.length === 0) return "";
  // Count leading zero bytes — each must be represented in the output.
  let leadingZeroBytes = 0;
  for (const b of data) {
    if (b === 0) leadingZeroBytes++;
    else break;
  }
  let value = 0n;
  for (const b of data) {
    value = (value << 8n) | BigInt(b);
  }
  let body = "";
  if (value === 0n) {
    body = "";
  } else {
    while (value > 0n) {
      const rem = Number(value % 32n);
      body = C32_ALPHABET[rem]! + body;
      value /= 32n;
    }
  }
  // Two 5-bit c32 digits cover 10 bits ≈ 1.25 bytes; the canonical codec uses
  // one "0" digit per leading zero byte. That is exactly invertible because
  // c32decode strips the same count back into zero bytes.
  return "0".repeat(leadingZeroBytes) + body;
}

/** Decode a c32 (Crockford base32) string back to bytes (inverse of c32encode). */
export function c32decode(encoded: string): Uint8Array {
  if (encoded.length === 0) return new Uint8Array(0);
  // Count leading "0" digits — these map back to leading zero bytes.
  let leadingZeroDigits = 0;
  for (const ch of encoded) {
    if (ch === "0") leadingZeroDigits++;
    else break;
  }
  let value = 0n;
  for (const ch of encoded) {
    const idx = C32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid c32 character: ${ch}`);
    value = value * 32n + BigInt(idx);
  }
  // Bytes from the big integer (big-endian).
  const out: number[] = [];
  let v = value;
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array([
    ...new Array<number>(leadingZeroDigits).fill(0),
    ...out,
  ]);
}

// ============================================================================
//  c32check — versioned, checksummed Stacks address codec
// ============================================================================

/** Stacks double-sha256: sha256(sha256(x)) — used for the c32check checksum. */
export function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * c32checkEncode(version, data):
 *   checksum   = dsha256(version_byte || data)[0..4]
 *   payload    = c32encode(data || checksum)
 *   address    = version_char || payload
 * where version_char = C32_ALPHABET[version].
 */
export function c32checkEncode(version: number, data: Uint8Array): string {
  if (version < 0 || version >= 32) {
    throw new Error(`c32 version must be 0..31, got ${version}`);
  }
  const checkInput = new Uint8Array(data.length + 1);
  checkInput[0] = version;
  checkInput.set(data, 1);
  const checksum = dsha256(checkInput).slice(0, 4);
  const body = new Uint8Array(data.length + 4);
  body.set(data, 0);
  body.set(checksum, data.length);
  const versionChar = C32_ALPHABET[version]!;
  return versionChar + c32encode(body);
}

export interface C32CheckDecoded {
  readonly version: number;
  readonly data: Uint8Array;
}

/**
 * Decode + verify a c32check address. Throws on bad checksum or unknown
 * version character.
 */
export function c32checkDecode(address: string): C32CheckDecoded {
  if (address.length < 2) throw new Error("c32check address too short");
  const versionChar = address[0]!;
  const version = C32_ALPHABET.indexOf(versionChar);
  if (version === -1) {
    throw new Error(`invalid c32 version character: ${versionChar}`);
  }
  const body = c32decode(address.slice(1));
  if (body.length < 4) throw new Error("c32check body too short for checksum");
  const data = body.slice(0, body.length - 4);
  const checksum = body.slice(body.length - 4);
  const checkInput = new Uint8Array(data.length + 1);
  checkInput[0] = version;
  checkInput.set(data, 1);
  const expected = dsha256(checkInput).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error("c32check checksum mismatch");
    }
  }
  return { version, data };
}

/**
 * Build a full Stacks c32check address (e.g. "ST…") that displays as the
 * canonical "S" + versionChar + c32(payload) Stacks convention. Stacks
 * addresses always begin with the literal "S" sigil followed by the c32
 * version character, so we prepend "S".
 */
export function c32address(version: number, hash160Bytes: Uint8Array): string {
  if (hash160Bytes.length !== 20) {
    throw new Error(
      `c32address expects a 20-byte hash160, got ${hash160Bytes.length}`
    );
  }
  return "S" + c32checkEncode(version, hash160Bytes);
}

/** Decode a Stacks "S…" address back to { version, hash160 }. */
export function c32addressDecode(address: string): {
  readonly version: number;
  readonly hash160: Uint8Array;
} {
  if (address[0] !== "S") {
    throw new Error(`Stacks address must start with "S", got "${address[0]}"`);
  }
  const { version, data } = c32checkDecode(address.slice(1));
  if (data.length !== 20) {
    throw new Error(`decoded hash160 must be 20 bytes, got ${data.length}`);
  }
  return { version, hash160: data };
}

// ============================================================================
//  Address derivation
// ============================================================================

/** hash160(x) = ripemd160(sha256(x)) — the 20-byte address program. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

export interface StacksKeypair {
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 33-byte COMPRESSED public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** 20-byte hash160(compressedPubkey) (hex). */
  readonly hash160Hex: string;
  /** c32check address — starts with "ST" on testnet, "SP" on mainnet. */
  readonly address: string;
  readonly network: StacksNetwork;
}

/** Build a keypair from a 32-byte secp256k1 private key. */
export function keypairFromPrivateKey(
  priv: Uint8Array,
  network: StacksNetwork = "testnet"
): StacksKeypair {
  if (priv.length !== 32) {
    throw new Error(`Stacks private key must be 32 bytes, got ${priv.length}`);
  }
  const pub = secp256k1.getPublicKey(priv, true); // COMPRESSED, 33 bytes
  const program = hash160(pub);
  const version = STACKS_VERSION[network];
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub),
    hash160Hex: toHex(program),
    address: c32address(version, program),
    network,
  };
}

/** Reconstruct a keypair from a hex private key (with or without 0x). */
export function keypairFromHex(
  privateKeyHex: string,
  network: StacksNetwork = "testnet"
): StacksKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex), network);
}

/**
 * Generate a fresh, cryptographically-random Stacks keypair fully in-process.
 * The address is a real c32check testnet address (starts "ST"), identical in
 * shape to one a testnet faucet would fund.
 */
export function generateStacksKeypair(
  network: StacksNetwork = "testnet"
): StacksKeypair {
  const priv = secp256k1.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv, network);
}

/**
 * Derive a keypair from a BIP39 mnemonic. Stacks wallets use the Stacks
 * derivation, but for an offline identity we take the first 32 bytes of the
 * BIP39 seed as the private key — deterministic + reproducible across runs.
 */
export function keypairFromMnemonic(
  mnemonic: string,
  network: StacksNetwork = "testnet"
): StacksKeypair {
  const seed = mnemonicToSeedSync(mnemonic);
  const priv = seed.slice(0, 32);
  return keypairFromPrivateKey(priv, network);
}

/** Generate a 24-word BIP39 mnemonic (256-bit entropy). */
export function generateStacksMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

// ============================================================================
//  RealStacksSigner
// ============================================================================

export interface RealStacksSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /** Or derive deterministically from a BIP39 mnemonic. */
  readonly mnemonic?: string;
  /** Network — defaults to "testnet". */
  readonly network?: StacksNetwork;
  /**
   * Optional balance reader — wired to a Stacks API `GET /extended/v1/address/
   * {principal}/stx` call in production. If omitted, getBalance() returns 0
   * (offline-safe default). Returns the balance in microSTX.
   */
  readonly balanceReader?: (address: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to Stacks API `POST /v2/transactions` in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature + a deterministic mock txid without hitting the network
   * (offline-safe).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountMicroStx: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly txid: string;
    readonly signer: string;
  }) => Promise<{ readonly txid?: string; readonly explorerUrl?: string }>;
}

export interface StacksSignResult {
  /** Compact ECDSA signature (hex, no 0x, 64-byte r||s) — verifiable offline. */
  readonly signature: string;
  /** sha256 of the canonical descriptor (hex) — stands in for the Stacks txid. */
  readonly txid: string;
  readonly explorerUrl: string;
}

export class RealStacksSigner {
  readonly address: string;
  readonly network: StacksNetwork;
  readonly publicKeyHex: string;
  private readonly priv: Uint8Array;
  private readonly cfg: RealStacksSignerConfig;

  constructor(cfg: RealStacksSignerConfig = {}) {
    this.network = cfg.network ?? "testnet";
    let kp: StacksKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey, this.network);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex, this.network);
    } else if (cfg.mnemonic) {
      kp = keypairFromMnemonic(cfg.mnemonic, this.network);
    } else {
      kp = generateStacksKeypair(this.network);
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
  }

  /**
   * Sign a canonical Stacks transfer descriptor with secp256k1 ECDSA over a
   * sha256 digest. The signature is REAL and verifiable offline (compact
   * 64-byte r||s, low-S normalized); the `submit` hook (when present)
   * assembles + broadcasts the actual Stacks token-transfer transaction.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountMicroStx: string;
    reference?: string;
    memo?: string;
  }): Promise<StacksSignResult> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountMicroStx: input.amountMicroStx,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const digest = sha256(new TextEncoder().encode(descriptor));
    // lowS:true → canonical signatures (matches Stacks/Bitcoin convention).
    const sig = secp256k1.sign(digest, this.priv, { lowS: true });
    const signature = toHex(sig.toCompactRawBytes()); // 64-byte r||s
    const txid = toHex(digest);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountMicroStx: input.amountMicroStx,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        txid,
        signer: this.address,
      });
      const finalTxid = res.txid ?? txid;
      return {
        signature,
        txid: finalTxid,
        explorerUrl: res.explorerUrl ?? this.explorerUrl(finalTxid),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return { signature, txid, explorerUrl: this.explorerUrl(txid) };
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address);
    }
    return 0n;
  }

  /**
   * Verify a compact signature this signer produced over a descriptor — for
   * tests + audits. Recomputes the sha256 digest and checks against the pubkey.
   */
  verify(signatureHexCompact: string, descriptor: string): boolean {
    try {
      const digest = sha256(new TextEncoder().encode(descriptor));
      const pub = secp256k1.getPublicKey(this.priv, true);
      const sig = secp256k1.Signature.fromCompact(
        hexToBytes(signatureHexCompact)
      );
      return secp256k1.verify(sig, digest, pub);
    } catch {
      return false;
    }
  }

  private explorerUrl(txid: string): string {
    const chain = this.network === "mainnet" ? "mainnet" : "testnet";
    return `https://explorer.hiro.so/txid/0x${txid}?chain=${chain}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Stacks STX transfer.
 * Stable field ordering so the same intent always yields the same digest +
 * signature. Stands in for a fully-serialized Stacks token-transfer payload in
 * the offline path.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountMicroStx: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `stacks-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount_ustx=${fields.amountMicroStx}`,
    `ref=${fields.reference ?? ""}`,
    `memo=${fields.memo ?? ""}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  Byte helpers (no Buffer dependency — works in browser + node)
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
