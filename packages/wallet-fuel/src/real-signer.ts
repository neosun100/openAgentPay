/**
 * RealFuelSigner — secp256k1 signer + native Fuel b256 address codec.
 * ============================================================================
 *
 * Fuel (FuelVM) is a novel-VM L2/L1 with its own account & address model:
 *
 *   - Crypto:      secp256k1 ECDSA. The FuelVM default signer signs over a
 *                  sha256 digest of the transaction id (Fuel uses sha256, NOT
 *                  keccak256 like the EVM). We expose a plain canonical ECDSA
 *                  signature (compact 64-byte r||s, low-S) over a sha256 digest
 *                  of a canonical transfer descriptor — fully verifiable offline.
 *   - Address:     b256 — a 32-byte value rendered as `0x` + 64 lowercase hex.
 *                  Fuel derives the account address from the public key as:
 *                      address = sha256(public_key)
 *                  where `public_key` is the 64-byte UNCOMPRESSED secp256k1 key
 *                  with the leading 0x04 SEC1 tag stripped (Fuel's raw 64-byte
 *                  pubkey form). This is NOT base58 (Solana), NOT bech32
 *                  (Bitcoin), NOT c32check (Stacks), NOT a keccak-truncated EVM
 *                  20-byte address — it is the full 32-byte sha256 image.
 *   - Asset:       Native ETH on Fuel has 9 decimals (Fuel's base-asset uses
 *                  9dp, not the EVM's 18dp). A USDC placeholder uses 6dp. Both
 *                  are addressed by a b256 AssetId; ETH's base AssetId is the
 *                  zero b256.
 *   - Settlement:  signs a canonical transfer descriptor; on-chain broadcast is
 *                  deferred behind the optional, pluggable `submit` hook
 *                  (offline-safe, deterministic mock txid). Explorer:
 *                  https://app.fuel.network.
 *
 * The cryptographic identity (keypair → b256 address → signature) is entirely
 * REAL and offline. Only the broadcast needs a live node; that lives in the
 * `submit` hook so production can wire a Fuel GraphQL push without touching
 * this module.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// ============================================================================
//  Network params
// ============================================================================

export type FuelNetwork = "testnet" | "mainnet";

/**
 * Fuel's base asset (ETH) AssetId is the zero b256. Kept as a constant so the
 * connector + tests can reference the canonical native-asset identifier.
 */
export const FUEL_BASE_ASSET_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** ETH on Fuel uses 9 decimals (Fuel base-asset precision), not the EVM's 18. */
export const FUEL_ETH_DECIMALS = 9;

// ============================================================================
//  b256 address codec — `0x` + 32-byte (64 hex char) value
// ============================================================================

/** True if `s` is a canonical b256: `0x` + exactly 64 lowercase-or-mixed hex. */
export function isB256(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

/** Render a 32-byte buffer as a b256 string (`0x` + 64 lowercase hex). */
export function toB256(data: Uint8Array): string {
  if (data.length !== 32) {
    throw new Error(`b256 expects 32 bytes, got ${data.length}`);
  }
  return "0x" + toHex(data);
}

/** Decode a b256 string back to its 32 raw bytes (throws if malformed). */
export function fromB256(address: string): Uint8Array {
  if (!isB256(address)) {
    throw new Error(`invalid b256 address: ${address}`);
  }
  return hexToBytes(address.slice(2));
}

// ============================================================================
//  Address derivation
// ============================================================================

/**
 * Fuel's raw public key: the 64-byte uncompressed secp256k1 key with the SEC1
 * 0x04 tag stripped. @noble returns a 65-byte uncompressed key (0x04 || X || Y).
 */
export function fuelRawPublicKey(uncompressed65: Uint8Array): Uint8Array {
  if (uncompressed65.length !== 65 || uncompressed65[0] !== 0x04) {
    throw new Error("expected a 65-byte SEC1 uncompressed public key (0x04…)");
  }
  return uncompressed65.slice(1); // 64 bytes: X || Y
}

/**
 * Fuel address = sha256(raw 64-byte public key) → 32-byte b256.
 * This matches the FuelVM account-address derivation for a secp256k1 signer.
 */
export function fuelAddressFromPublicKey(uncompressed65: Uint8Array): string {
  const raw = fuelRawPublicKey(uncompressed65);
  return toB256(sha256(raw));
}

export interface FuelKeypair {
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 64-byte RAW public key (X||Y, no 0x04 tag) as hex. */
  readonly publicKeyHex: string;
  /** b256 account address — `0x` + 64 hex (sha256 of the raw pubkey). */
  readonly address: string;
  readonly network: FuelNetwork;
}

/** Build a keypair from a 32-byte secp256k1 private key. */
export function keypairFromPrivateKey(
  priv: Uint8Array,
  network: FuelNetwork = "testnet"
): FuelKeypair {
  if (priv.length !== 32) {
    throw new Error(`Fuel private key must be 32 bytes, got ${priv.length}`);
  }
  const uncompressed = secp256k1.getPublicKey(priv, false); // 65 bytes, 0x04…
  const raw = fuelRawPublicKey(uncompressed);
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(raw),
    address: fuelAddressFromPublicKey(uncompressed),
    network,
  };
}

/** Reconstruct a keypair from a hex private key (with or without 0x). */
export function keypairFromHex(
  privateKeyHex: string,
  network: FuelNetwork = "testnet"
): FuelKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex), network);
}

/**
 * Generate a fresh, cryptographically-random Fuel keypair fully in-process.
 * The address is a real b256, identical in shape to one a testnet faucet would
 * fund.
 */
export function generateFuelKeypair(
  network: FuelNetwork = "testnet"
): FuelKeypair {
  const priv = secp256k1.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv, network);
}

/**
 * Derive a keypair from a BIP39 mnemonic. For an offline identity we take the
 * first 32 bytes of the BIP39 seed as the private key — deterministic +
 * reproducible across runs.
 */
export function keypairFromMnemonic(
  mnemonic: string,
  network: FuelNetwork = "testnet"
): FuelKeypair {
  const seed = mnemonicToSeedSync(mnemonic);
  const priv = seed.slice(0, 32);
  return keypairFromPrivateKey(priv, network);
}

/** Generate a 24-word BIP39 mnemonic (256-bit entropy). */
export function generateFuelMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

// ============================================================================
//  RealFuelSigner
// ============================================================================

export interface RealFuelSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /** Or derive deterministically from a BIP39 mnemonic. */
  readonly mnemonic?: string;
  /** Network — defaults to "testnet". */
  readonly network?: FuelNetwork;
  /**
   * Optional balance reader — wired to a Fuel GraphQL `balance` query in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   * Returns the balance in the asset's smallest unit.
   */
  readonly balanceReader?: (address: string, assetId: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to Fuel GraphQL `submit` mutation in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature + a deterministic mock txid without hitting the network
   * (offline-safe).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amount: string;
    readonly assetId: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly txid: string;
    readonly signer: string;
  }) => Promise<{ readonly txid?: string; readonly explorerUrl?: string }>;
}

export interface FuelSignResult {
  /** Compact ECDSA signature (hex, no 0x, 64-byte r||s) — verifiable offline. */
  readonly signature: string;
  /** sha256 of the canonical descriptor as a b256 — stands in for the Fuel txid. */
  readonly txid: string;
  readonly explorerUrl: string;
}

export class RealFuelSigner {
  readonly address: string;
  readonly network: FuelNetwork;
  readonly publicKeyHex: string;
  private readonly priv: Uint8Array;
  private readonly cfg: RealFuelSignerConfig;

  constructor(cfg: RealFuelSignerConfig = {}) {
    this.network = cfg.network ?? "testnet";
    let kp: FuelKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey, this.network);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex, this.network);
    } else if (cfg.mnemonic) {
      kp = keypairFromMnemonic(cfg.mnemonic, this.network);
    } else {
      kp = generateFuelKeypair(this.network);
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
  }

  /**
   * Sign a canonical Fuel transfer descriptor with secp256k1 ECDSA over a
   * sha256 digest (FuelVM uses sha256 for tx ids). The signature is REAL and
   * verifiable offline (compact 64-byte r||s, low-S normalized); the `submit`
   * hook (when present) assembles + broadcasts the actual Fuel transfer.
   */
  async signAndSubmit(input: {
    recipient: string;
    amount: string;
    assetId?: string;
    reference?: string;
    memo?: string;
  }): Promise<FuelSignResult> {
    const assetId = input.assetId ?? FUEL_BASE_ASSET_ID;
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amount: input.amount,
      assetId,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const digest = sha256(new TextEncoder().encode(descriptor));
    // lowS:true → canonical signatures (matches Fuel/Bitcoin convention).
    const sig = secp256k1.sign(digest, this.priv, { lowS: true });
    const signature = toHex(sig.toCompactRawBytes()); // 64-byte r||s
    const txid = "0x" + toHex(digest);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amount: input.amount,
        assetId,
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

  async getBalance(assetId: string = FUEL_BASE_ASSET_ID): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, assetId);
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
      const uncompressed = secp256k1.getPublicKey(this.priv, false);
      const sig = secp256k1.Signature.fromCompact(
        hexToBytes(signatureHexCompact)
      );
      return secp256k1.verify(sig, digest, uncompressed);
    } catch {
      return false;
    }
  }

  private explorerUrl(txid: string): string {
    return `https://app.fuel.network/tx/${txid}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Fuel asset transfer.
 * Stable field ordering so the same intent always yields the same digest +
 * signature. Stands in for a fully-serialized FuelVM transfer transaction in
 * the offline path.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amount: string;
  assetId: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `fuel-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amount}`,
    `asset=${fields.assetId}`,
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
