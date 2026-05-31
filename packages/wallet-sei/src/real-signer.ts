/**
 * RealSeiSigner — secp256k1 signer backed by @noble/curves, no @cosmjs/* deps.
 * ============================================================================
 *
 * Sei is a Cosmos-SDK chain, so the cryptographic identity is identical to the
 * Cosmos Hub model — only the bech32 human-readable prefix changes ("sei").
 *
 *   - Crypto: secp256k1 ECDSA over a sha256 digest (compressed pubkeys).
 *   - Identity: 24-word BIP39 mnemonic → BIP44 m/44'/118'/0'/0/0 (Sei uses the
 *     standard Cosmos coin type 118).
 *   - Address: bech32("sei", ripemd160(sha256(compressed_pubkey))) → "sei1…".
 *   - Settlement: bank MsgSend (vs EVM contract call). Pluggable via `submit`.
 *
 * Why not @cosmjs/*?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (mnemonic → key → address → signature) is
 *     fully real here; only the RPC *broadcast* needs a live chain. We keep
 *     that pluggable via the optional `submit` hook so production can wire
 *     @cosmjs/stargate's SigningStargateClient without changing this file.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// ============================================================================
//  Constants
// ============================================================================

/** Sei uses the standard Cosmos BIP44 coin type. */
export const SEI_COIN_TYPE = 118;
/** Canonical Sei derivation path (Cosmos-standard m/44'/118'/0'/0/0). */
export const SEI_HD_PATH = "m/44'/118'/0'/0/0";
/** Sei bech32 human-readable prefix. */
export const SEI_BECH32_PREFIX = "sei";

// ============================================================================
//  Wallet / keypair helpers
// ============================================================================

export interface SeiWallet {
  /** 24-word BIP39 mnemonic (256-bit entropy). */
  readonly mnemonic: string;
  /** bech32 "sei1…" address. */
  readonly address: string;
}

export interface SeiKeypair {
  readonly mnemonic: string;
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 33-byte compressed secp256k1 public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** bech32 address with the configured prefix. */
  readonly address: string;
  /** Human-readable bech32 prefix used for the address. */
  readonly prefix: string;
}

/**
 * Generate a fresh Sei wallet — a real 24-word mnemonic plus the canonical
 * "sei1…" address. Fully offline; no faucet/network involved.
 */
export function generateSeiWallet(prefix = SEI_BECH32_PREFIX): SeiWallet {
  const kp = generateSeiKeypair(prefix);
  return { mnemonic: kp.mnemonic, address: kp.address };
}

/** Full keypair generation — mnemonic + derived secp256k1 key + bech32 address. */
export function generateSeiKeypair(prefix = SEI_BECH32_PREFIX): SeiKeypair {
  // 256 bits of entropy → 24-word mnemonic.
  const mnemonic = generateMnemonic(wordlist, 256);
  return keypairFromMnemonic(mnemonic, prefix);
}

/**
 * Derive a Sei keypair from an existing BIP39 mnemonic. Validates the
 * mnemonic against the English wordlist + checksum before deriving.
 */
export function keypairFromMnemonic(
  mnemonic: string,
  prefix = SEI_BECH32_PREFIX
): SeiKeypair {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic (failed wordlist/checksum check)");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive(SEI_HD_PATH);
  if (!node.privateKey) {
    throw new Error(`Failed to derive private key at ${SEI_HD_PATH}`);
  }
  const privateKey = node.privateKey;
  // Always recompute the compressed pubkey from the private key (canonical).
  const publicKey = secp256k1.getPublicKey(privateKey, true); // 33 bytes
  const address = addressFromPublicKey(publicKey, prefix);
  return {
    mnemonic,
    privateKeyHex: toHex(privateKey),
    publicKeyHex: toHex(publicKey),
    address,
    prefix,
  };
}

/**
 * Compute a bech32 address from a compressed secp256k1 public key:
 *   address = bech32(prefix, ripemd160(sha256(pubkey)))
 */
export function addressFromPublicKey(
  publicKey: Uint8Array,
  prefix = SEI_BECH32_PREFIX
): string {
  let pub = publicKey;
  if (pub.length !== 33) {
    // Accept uncompressed (65) by compressing first.
    if (pub.length === 65) {
      const point = secp256k1.ProjectivePoint.fromHex(pub);
      pub = point.toRawBytes(true);
    } else {
      throw new Error(
        `Sei pubkey must be 33 (compressed) or 65 (uncompressed) bytes, got ${pub.length}`
      );
    }
  }
  const ripe = ripemd160(sha256(pub)); // 20 bytes
  return bech32.encode(prefix, bech32.toWords(ripe));
}

// ============================================================================
//  RealSeiSigner
// ============================================================================

export interface RealSeiSignerConfig {
  /** Supply an existing 24-word mnemonic. */
  readonly mnemonic?: string;
  /** bech32 prefix (default "sei"). */
  readonly prefix?: string;
  /** Chain id for explorer URLs / network labels (default "pacific-1"). */
  readonly chainId?: string;
  /**
   * Optional balance reader — wired to a Sei LCD/REST endpoint in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: string, denom?: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to @cosmjs/stargate broadcastTx in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly denom: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
    readonly pubkeyHex: string;
  }) => Promise<{ readonly txHash?: string; readonly height?: number }>;
}

export class RealSeiSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  readonly prefix: string;
  readonly chainId: string;
  private readonly privateKey: Uint8Array;
  private readonly cfg: RealSeiSignerConfig;

  constructor(cfg: RealSeiSignerConfig = {}) {
    const prefix = cfg.prefix ?? SEI_BECH32_PREFIX;
    const kp = cfg.mnemonic
      ? keypairFromMnemonic(cfg.mnemonic, prefix)
      : generateSeiKeypair(prefix);
    this.privateKey = hexToBytes(kp.privateKeyHex);
    this.publicKeyHex = kp.publicKeyHex;
    this.address = kp.address;
    this.prefix = prefix;
    this.chainId = cfg.chainId ?? "pacific-1";
    this.cfg = cfg;
  }

  /**
   * Sign a deterministic descriptor derived from the transfer intent. This is
   * a real secp256k1 ECDSA signature over sha256(descriptor), returned as
   * hex (compact 64-byte r||s). The production `submit` hook assembles +
   * broadcasts the actual on-chain bank transfer.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    denom: string;
    memo?: string;
  }): Promise<{
    signature: string;
    txHash?: string;
    height?: number;
    explorerUrl?: string;
  }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      denom: input.denom,
      chainId: this.chainId,
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msgHash = sha256(new TextEncoder().encode(descriptor));
    const sig = secp256k1.sign(msgHash, this.privateKey);
    const signature = toHex(sig.toCompactRawBytes()); // 64-byte r||s, hex

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        denom: input.denom,
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.address,
        pubkeyHex: this.publicKeyHex,
      });
      return {
        signature,
        ...(res.txHash !== undefined ? { txHash: res.txHash } : {}),
        ...(res.height !== undefined ? { height: res.height } : {}),
        ...(res.txHash !== undefined
          ? { explorerUrl: this.explorerUrl(res.txHash) }
          : {}),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return { signature };
  }

  async getBalance(denom = "usei"): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, denom);
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

  private explorerUrl(txHash: string): string {
    return `https://www.mintscan.io/sei/txs/${txHash}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Sei bank transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  denom: string;
  chainId: string;
  memo?: string;
}): string {
  const parts = [
    `sei-pay/v1`,
    `chain=${fields.chainId}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `denom=${fields.denom}`,
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
