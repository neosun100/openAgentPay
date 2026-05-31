/**
 * RealBitcoinSigner — secp256k1 (ECDSA) signer backed by @noble/curves, no bitcoinjs-lib.
 * ============================================================================
 *
 * Mirrors `RealTronSigner` but for the Bitcoin chain model:
 *
 *   - Crypto:      secp256k1 ECDSA (same curve as Ethereum/Tron)
 *   - Address:     native SegWit testnet P2WPKH — witness v0:
 *                  bech32("tb", [0x00, ...convertbits(hash160(compressedPubkey),8,5)])
 *                  where hash160(x) = ripemd160(sha256(x)).
 *                  → string starting "tb1q" (e.g. tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx)
 *   - Asset:       BTC (8 dp, smallest unit = satoshi)
 *   - Settlement:  signs a canonical PSBT-like transfer descriptor; on-chain
 *                  broadcast deferred behind the optional, pluggable `submit`
 *                  hook (offline-safe, deterministic mock txid).
 *
 * The cryptographic identity (keypair → address → signature) is fully REAL and
 * offline. Only the on-chain broadcast needs a live node; that is kept in the
 * `submit` hook so production can wire an Esplora/Electrum push without
 * touching this file.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/legacy";
import { bech32 } from "@scure/base";

// ============================================================================
//  Network params
// ============================================================================

export type BitcoinNetwork = "testnet" | "signet" | "mainnet";

/** Human-readable part (hrp) for the bech32 SegWit address by network. */
export function hrpForNetwork(network: BitcoinNetwork): "tb" | "bc" {
  // testnet AND signet both use "tb"; mainnet uses "bc".
  return network === "mainnet" ? "bc" : "tb";
}

/** Witness version 0 — the value P2WPKH/P2WSH carry as the first 5-bit word. */
export const WITNESS_VERSION_V0 = 0x00;

// ============================================================================
//  Address codec — bech32 witness v0 P2WPKH
// ============================================================================

/** hash160(x) = ripemd160(sha256(x)) — the 20-byte witness program for P2WPKH. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Encode a native-SegWit (witness v0) P2WPKH address from a 20-byte hash160.
 * Layout: bech32(hrp, [witnessVersion, ...toWords(program8bit)]).
 */
export function encodeSegwitV0Address(
  hash160Bytes: Uint8Array,
  network: BitcoinNetwork = "testnet"
): string {
  if (hash160Bytes.length !== 20) {
    throw new Error(
      `P2WPKH witness program must be 20 bytes, got ${hash160Bytes.length}`
    );
  }
  const hrp = hrpForNetwork(network);
  const words = [WITNESS_VERSION_V0, ...bech32.toWords(hash160Bytes)];
  // bech32 (not bech32m) is correct for witness v0 per BIP-173.
  return bech32.encode(hrp, words);
}

/**
 * Decode a witness v0 P2WPKH address back to its 20-byte program. Throws on
 * bad checksum, wrong hrp, non-v0 witness version, or wrong program length.
 */
export function decodeSegwitV0Address(
  address: string,
  network: BitcoinNetwork = "testnet"
): Uint8Array {
  const hrp = hrpForNetwork(network);
  const decoded = bech32.decode(address as `${string}1${string}`);
  if (decoded.prefix !== hrp) {
    throw new Error(
      `bech32 hrp mismatch: expected "${hrp}", got "${decoded.prefix}"`
    );
  }
  const words = decoded.words;
  const version = words[0];
  if (version !== WITNESS_VERSION_V0) {
    throw new Error(`expected witness version 0, got ${version ?? "none"}`);
  }
  const program = bech32.fromWords(words.slice(1));
  if (program.length !== 20) {
    throw new Error(
      `P2WPKH program must decode to 20 bytes, got ${program.length}`
    );
  }
  return program;
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface BitcoinKeypair {
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 33-byte COMPRESSED public key (hex, no 0x, 0x02/0x03-prefixed). */
  readonly publicKeyHex: string;
  /** 20-byte hash160(compressedPubkey) — the witness program (hex). */
  readonly hash160Hex: string;
  /** bech32 native-SegWit address — starts with "tb1q" on testnet. */
  readonly address: string;
  /** The network this address belongs to. */
  readonly network: BitcoinNetwork;
}

/** Build a keypair from a 32-byte secp256k1 private key. */
export function keypairFromPrivateKey(
  priv: Uint8Array,
  network: BitcoinNetwork = "testnet"
): BitcoinKeypair {
  if (priv.length !== 32) {
    throw new Error(`Bitcoin private key must be 32 bytes, got ${priv.length}`);
  }
  const pub = secp256k1.getPublicKey(priv, true); // COMPRESSED, 33 bytes
  const program = hash160(pub);
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub),
    hash160Hex: toHex(program),
    address: encodeSegwitV0Address(program, network),
    network,
  };
}

/**
 * Generate a fresh, cryptographically-random Bitcoin keypair fully in-process.
 * The address is a real bech32 testnet P2WPKH address (starts "tb1q"),
 * identical in shape to one a testnet faucet would fund.
 */
export function generateBitcoinKeypair(
  network: BitcoinNetwork = "testnet"
): BitcoinKeypair {
  const priv = secp256k1.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv, network);
}

/** Reconstruct a keypair from a hex private key (with or without 0x). */
export function keypairFromHex(
  privateKeyHex: string,
  network: BitcoinNetwork = "testnet"
): BitcoinKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex), network);
}

// ============================================================================
//  RealBitcoinSigner
// ============================================================================

export interface RealBitcoinSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /** Network — defaults to "testnet". */
  readonly network?: BitcoinNetwork;
  /**
   * Optional balance reader — wired to an Esplora/Electrum REST call in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   * Returns the confirmed balance in satoshis.
   */
  readonly balanceReader?: (address: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to Esplora `POST /tx` (or Electrum
   * `blockchain.transaction.broadcast`) in production. If omitted,
   * signAndSubmit() returns the locally-computed signature + a deterministic
   * mock txid without hitting the network (offline-safe).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountSats: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly txid: string;
    readonly signer: string;
  }) => Promise<{ readonly txid?: string; readonly explorerUrl?: string }>;
}

export interface BitcoinSignResult {
  /** DER-encoded ECDSA signature (hex, no 0x) — the canonical Bitcoin sig form. */
  readonly signature: string;
  /** Double-SHA256 txid over the canonical descriptor (hex, big-endian display). */
  readonly txid: string;
  readonly explorerUrl: string;
}

export class RealBitcoinSigner {
  readonly address: string;
  readonly network: BitcoinNetwork;
  private readonly priv: Uint8Array;
  private readonly cfg: RealBitcoinSignerConfig;

  constructor(cfg: RealBitcoinSignerConfig = {}) {
    this.network = cfg.network ?? "testnet";
    let kp: BitcoinKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey, this.network);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex, this.network);
    } else {
      kp = generateBitcoinKeypair(this.network);
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.cfg = cfg;
  }

  /**
   * Sign a canonical Bitcoin transfer descriptor with secp256k1 ECDSA. The
   * signed message is the BIP-143-style sighash = dSHA256(descriptor) — the
   * same double-SHA256 commitment Bitcoin uses for transaction signing. The
   * signature is REAL and verifiable offline (DER-encoded, low-S normalized);
   * the `submit` hook (when present) assembles + broadcasts the actual PSBT.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountSats: string;
    reference?: string;
    memo?: string;
  }): Promise<BitcoinSignResult> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountSats: input.amountSats,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const sighash = dsha256(new TextEncoder().encode(descriptor));
    // lowS:true → canonical Bitcoin signatures (BIP-62 / BIP-146).
    const sig = secp256k1.sign(sighash, this.priv, { lowS: true });
    const signature = toHex(sig.toDERRawBytes());
    // Bitcoin displays txids big-endian (reverse of internal byte order).
    const txid = toHex(reverseBytes(sighash));

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountSats: input.amountSats,
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
   * Verify a DER signature this signer produced over a descriptor — for tests
   * + audits. Recomputes the dSHA256 sighash and checks against the pubkey.
   */
  verify(signatureHexDer: string, descriptor: string): boolean {
    try {
      const sighash = dsha256(new TextEncoder().encode(descriptor));
      const pub = secp256k1.getPublicKey(this.priv, true);
      const sig = secp256k1.Signature.fromDER(hexToBytes(signatureHexDer));
      return secp256k1.verify(sig, sighash, pub);
    } catch {
      return false;
    }
  }

  private explorerUrl(txid: string): string {
    if (this.network === "mainnet") {
      return `https://mempool.space/tx/${txid}`;
    }
    return `https://mempool.space/${this.network}/tx/${txid}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Bitcoin transfer. Stable
 * field ordering so the same intent always yields the same sighash + signature.
 * Stands in for a fully-serialized PSBT in the offline path.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountSats: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `bitcoin-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount_sats=${fields.amountSats}`,
    `ref=${fields.reference ?? ""}`,
    `memo=${fields.memo ?? ""}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  Hash + byte helpers (no Buffer dependency — works in browser + node)
// ============================================================================

/** Bitcoin's double-SHA256: sha256(sha256(x)). */
export function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[bytes.length - 1 - i]!;
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
