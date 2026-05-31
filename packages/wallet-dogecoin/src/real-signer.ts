/**
 * RealDogecoinSigner — secp256k1 (ECDSA) signer backed by @noble/curves, no doge libs.
 * ============================================================================
 *
 * Mirrors `RealBitcoinSigner` but for the DOGECOIN chain model. Dogecoin is a
 * Bitcoin fork that NEVER adopted SegWit, so addresses are classic legacy
 * Pay-to-Public-Key-Hash (P2PKH) encoded with base58check (like Bitcoin's
 * "1..." addresses, but with Doge-specific version bytes):
 *
 *   - Crypto:      secp256k1 ECDSA (same curve as Bitcoin/Ethereum/Tron)
 *   - Address:     base58check( versionByte || ripemd160(sha256(compressedPubkey)) )
 *                    versionByte = 0x1e (mainnet) → "D..."
 *                    versionByte = 0x71 (testnet) → "n..." / "m..."
 *                  (this is the same base58check used by Tron, just with a
 *                   1-byte version prefix instead of Tron's 0x41)
 *   - Asset:       DOGE (8 dp, smallest unit = "koinu" / 1e-8 DOGE)
 *   - Settlement:  signs a canonical legacy-transfer descriptor; on-chain
 *                  broadcast deferred behind the optional, pluggable `submit`
 *                  hook (offline-safe, deterministic mock txid).
 *
 * The cryptographic identity (keypair → address → signature) is fully REAL and
 * offline. Only the on-chain broadcast needs a live node; that is kept in the
 * `submit` hook so production can wire a Blockcypher/Doge-RPC push without
 * touching this file.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/legacy";
import { base58 } from "@scure/base";

// ============================================================================
//  Network params
// ============================================================================

export type DogecoinNetwork = "testnet" | "mainnet";

/**
 * P2PKH version byte (the base58check prefix) per network.
 *   mainnet 0x1e → addresses begin with "D"
 *   testnet 0x71 → addresses begin with "n" (occasionally "m")
 */
export function p2pkhVersionByte(network: DogecoinNetwork): number {
  return network === "mainnet" ? 0x1e : 0x71;
}

// ============================================================================
//  base58check codec (= base58( payload || dsha256(payload)[:4] ))
// ============================================================================

/** Dogecoin's double-SHA256: sha256(sha256(x)). */
export function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** base58check encode: payload || dsha256(payload)[:4], then base58. */
export function base58CheckEncode(payload: Uint8Array): string {
  const checksum = dsha256(payload).slice(0, 4);
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
  const expected = dsha256(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error(`base58check checksum mismatch for ${encoded}`);
    }
  }
  return payload;
}

// ============================================================================
//  Address codec — legacy P2PKH
// ============================================================================

/** hash160(x) = ripemd160(sha256(x)) — the 20-byte pubkey hash for P2PKH. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Encode a legacy P2PKH address from a 20-byte hash160:
 *   base58check( versionByte || hash160 ).
 */
export function encodeP2PKHAddress(
  hash160Bytes: Uint8Array,
  network: DogecoinNetwork = "testnet"
): string {
  if (hash160Bytes.length !== 20) {
    throw new Error(
      `P2PKH pubkey hash must be 20 bytes, got ${hash160Bytes.length}`
    );
  }
  const version = p2pkhVersionByte(network);
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(hash160Bytes, 1);
  return base58CheckEncode(payload);
}

/**
 * Decode a legacy P2PKH address back to its 20-byte hash160. Throws on bad
 * checksum, wrong version byte for the network, or wrong payload length.
 */
export function decodeP2PKHAddress(
  address: string,
  network: DogecoinNetwork = "testnet"
): Uint8Array {
  const payload = base58CheckDecode(address);
  if (payload.length !== 21) {
    throw new Error(
      `P2PKH payload must be 21 bytes (version + hash160), got ${payload.length}`
    );
  }
  const expectedVersion = p2pkhVersionByte(network);
  if (payload[0] !== expectedVersion) {
    throw new Error(
      `version byte mismatch: expected 0x${expectedVersion.toString(
        16
      )}, got 0x${(payload[0] ?? 0).toString(16)}`
    );
  }
  return payload.slice(1);
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface DogecoinKeypair {
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 33-byte COMPRESSED public key (hex, no 0x, 0x02/0x03-prefixed). */
  readonly publicKeyHex: string;
  /** 20-byte hash160(compressedPubkey) — the pubkey hash (hex). */
  readonly hash160Hex: string;
  /** base58check P2PKH address — "D…" on mainnet, "n…"/"m…" on testnet. */
  readonly address: string;
  /** The network this address belongs to. */
  readonly network: DogecoinNetwork;
}

/** Build a keypair from a 32-byte secp256k1 private key. */
export function keypairFromPrivateKey(
  priv: Uint8Array,
  network: DogecoinNetwork = "testnet"
): DogecoinKeypair {
  if (priv.length !== 32) {
    throw new Error(
      `Dogecoin private key must be 32 bytes, got ${priv.length}`
    );
  }
  const pub = secp256k1.getPublicKey(priv, true); // COMPRESSED, 33 bytes
  const program = hash160(pub);
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub),
    hash160Hex: toHex(program),
    address: encodeP2PKHAddress(program, network),
    network,
  };
}

/**
 * Generate a fresh, cryptographically-random Dogecoin keypair fully in-process.
 * The address is a real base58check testnet P2PKH address (starts "n"/"m"),
 * identical in shape to one a Dogecoin testnet faucet would fund.
 */
export function generateDogecoinKeypair(
  network: DogecoinNetwork = "testnet"
): DogecoinKeypair {
  const priv = secp256k1.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv, network);
}

/** Reconstruct a keypair from a hex private key (with or without 0x). */
export function keypairFromHex(
  privateKeyHex: string,
  network: DogecoinNetwork = "testnet"
): DogecoinKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex), network);
}

// ============================================================================
//  RealDogecoinSigner
// ============================================================================

export interface RealDogecoinSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /** Network — defaults to "testnet". */
  readonly network?: DogecoinNetwork;
  /**
   * Optional balance reader — wired to a Blockcypher/Doge-RPC REST call in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   * Returns the confirmed balance in koinu (1 DOGE = 1e8 koinu).
   */
  readonly balanceReader?: (address: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to a Dogecoin node `sendrawtransaction`
   * (or Blockcypher `POST /txs/push`) in production. If omitted,
   * signAndSubmit() returns the locally-computed signature + a deterministic
   * mock txid without hitting the network (offline-safe).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountKoinu: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly txid: string;
    readonly signer: string;
  }) => Promise<{ readonly txid?: string; readonly explorerUrl?: string }>;
}

export interface DogecoinSignResult {
  /** DER-encoded ECDSA signature (hex, no 0x) — the canonical Bitcoin/Doge sig form. */
  readonly signature: string;
  /** Double-SHA256 txid over the canonical descriptor (hex, big-endian display). */
  readonly txid: string;
  readonly explorerUrl: string;
}

export class RealDogecoinSigner {
  readonly address: string;
  readonly network: DogecoinNetwork;
  private readonly priv: Uint8Array;
  private readonly cfg: RealDogecoinSignerConfig;

  constructor(cfg: RealDogecoinSignerConfig = {}) {
    this.network = cfg.network ?? "testnet";
    let kp: DogecoinKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey, this.network);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex, this.network);
    } else {
      kp = generateDogecoinKeypair(this.network);
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.cfg = cfg;
  }

  /**
   * Sign a canonical Dogecoin transfer descriptor with secp256k1 ECDSA. The
   * signed message is the sighash = dSHA256(descriptor) — the same
   * double-SHA256 commitment Bitcoin/Dogecoin uses for transaction signing.
   * The signature is REAL and verifiable offline (DER-encoded, low-S
   * normalized per BIP-62/146); the `submit` hook (when present) assembles +
   * broadcasts the actual legacy transaction.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountKoinu: string;
    reference?: string;
    memo?: string;
  }): Promise<DogecoinSignResult> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountKoinu: input.amountKoinu,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const sighash = dsha256(new TextEncoder().encode(descriptor));
    // lowS:true → canonical signatures (BIP-62 / BIP-146).
    const sig = secp256k1.sign(sighash, this.priv, { lowS: true });
    const signature = toHex(sig.toDERRawBytes());
    // Bitcoin/Dogecoin display txids big-endian (reverse of internal order).
    const txid = toHex(reverseBytes(sighash));

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountKoinu: input.amountKoinu,
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
    // Dogecoin block explorers. Testnet via blockexplorer.one / sochain.
    if (this.network === "mainnet") {
      return `https://dogechain.info/tx/${txid}`;
    }
    return `https://blockexplorer.one/dogecoin/testnet/tx/${txid}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Dogecoin transfer. Stable
 * field ordering so the same intent always yields the same sighash + signature.
 * Stands in for a fully-serialized legacy transaction in the offline path.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountKoinu: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `dogecoin-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount_koinu=${fields.amountKoinu}`,
    `ref=${fields.reference ?? ""}`,
    `memo=${fields.memo ?? ""}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  Byte / hex helpers (no Buffer dependency — works in browser + node)
// ============================================================================

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
