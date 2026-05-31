/**
 * RealStarknetSigner — secp256k1 signer + felt252-shaped Starknet address codec.
 * ============================================================================
 *
 * Starknet is a STARK-friendly validity-rollup L2. Its native account model and
 * crypto differ from EVM chains:
 *
 *   - Native curve: Starknet uses the **STARK-friendly curve** (a.k.a. the
 *     "Stark curve") with Pedersen/Poseidon hashes — NOT secp256k1. Producing a
 *     genuine STARK-curve signature with a battle-tested offline library is
 *     heavy and not available in this monorepo's dependency set.
 *
 *   - Address shape: a Starknet address is a **felt252** — a field element of
 *     the STARK prime field (P ≈ 2^251 + 17·2^192 + 1). Rendered as
 *     `0x` + up to 64 hex chars, value strictly < P.
 *
 *   - Asset: native ETH (18 decimals) bridged from L1, plus USDC (6 decimals).
 *
 * DESIGN DECISION (documented, testnet-shaped):
 *   To keep the signer fully offline + real with zero signups, we:
 *     1. Generate a REAL secp256k1 keypair (same family as Bitcoin/Ethereum).
 *     2. Derive a deterministic **felt-shaped** address:
 *            address = "0x" + keccak256(compressedPubkey)[0..31 bytes → 62 hex]
 *        62 hex = 248 bits < 252-bit STARK field ⇒ always a valid felt252.
 *        This is a TESTNET-SHAPED address: it has the exact on-the-wire shape a
 *        Starknet account address has (felt252, < P), but is derived via
 *        secp256k1+keccak rather than the Stark-curve account-contract deploy
 *        hash. It is stable, reproducible, and never collides with a real
 *        deployed account.
 *     3. Produce a REAL secp256k1 ECDSA signature over the sha256 digest of a
 *        canonical transfer descriptor — fully verifiable offline, and bound to
 *        the payment intent (tampering the descriptor fails verification).
 *
 * The cryptographic identity (keypair → felt252 address → signature) is real
 * and offline. Only broadcast needs a live Starknet node; that lives behind the
 * pluggable `submit` hook so production can wire `starknet_addInvokeTransaction`
 * without touching this file.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";

// ============================================================================
//  Network params
// ============================================================================

export type StarknetNetwork = "sepolia" | "mainnet";

/**
 * The STARK prime field modulus P = 2^251 + 17·2^192 + 1. Every valid Starknet
 * felt252 address satisfies 0 <= addr < P. We assert our derived addresses fall
 * inside this range so they are structurally valid felts.
 */
export const STARK_PRIME =
  0x0800000000000011000000000000000000000000000000000000000000000001n;

/** Explorer base per network (Starkscan). */
export function explorerBase(network: StarknetNetwork): string {
  return network === "mainnet"
    ? "https://starkscan.co"
    : "https://sepolia.starkscan.co";
}

// ============================================================================
//  felt252-shaped address codec
// ============================================================================

/**
 * Normalize a felt hex string to canonical `0x` + lowercase hex, no leading
 * zeroes beyond a single one when zero. Throws if it exceeds the felt field.
 */
export function normalizeFelt(hex: string): string {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length === 0) throw new Error("empty felt");
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`invalid felt hex: ${hex}`);
  }
  const value = BigInt("0x" + clean);
  if (value >= STARK_PRIME) {
    throw new Error(`felt out of STARK field range: ${hex}`);
  }
  // up to 64 hex chars, no superfluous leading zeros
  return "0x" + value.toString(16);
}

/** True if `addr` is a structurally valid Starknet felt252 address. */
export function isFelt(addr: string): boolean {
  try {
    normalizeFelt(addr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive a deterministic, testnet-shaped felt252 address from a compressed
 * secp256k1 public key:
 *     keccak256(pubkey) → take the first 31 bytes (62 hex = 248 bits) → felt.
 * 248 bits < 252-bit field ⇒ always < STARK_PRIME ⇒ always a valid felt.
 */
export function feltAddressFromPublicKey(pubkey: Uint8Array): string {
  const digest = keccak_256(pubkey); // 32 bytes
  const first31 = digest.slice(0, 31); // 248 bits, guaranteed < P
  const hex = toHex(first31);
  return normalizeFelt(hex);
}

// ============================================================================
//  Keypair derivation
// ============================================================================

export interface StarknetKeypair {
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 33-byte COMPRESSED secp256k1 public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** felt252-shaped address — `0x` + up to 64 hex (testnet-shaped). */
  readonly address: string;
  readonly network: StarknetNetwork;
}

/** Build a keypair from a 32-byte secp256k1 private key. */
export function keypairFromPrivateKey(
  priv: Uint8Array,
  network: StarknetNetwork = "sepolia"
): StarknetKeypair {
  if (priv.length !== 32) {
    throw new Error(`Starknet private key must be 32 bytes, got ${priv.length}`);
  }
  const pub = secp256k1.getPublicKey(priv, true); // compressed, 33 bytes
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub),
    address: feltAddressFromPublicKey(pub),
    network,
  };
}

/** Reconstruct a keypair from a hex private key (with or without 0x). */
export function keypairFromHex(
  privateKeyHex: string,
  network: StarknetNetwork = "sepolia"
): StarknetKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex), network);
}

/**
 * Generate a fresh, cryptographically-random Starknet keypair fully in-process.
 * The address is a real felt252-shaped Sepolia address (testnet-shaped).
 */
export function generateStarknetKeypair(
  network: StarknetNetwork = "sepolia"
): StarknetKeypair {
  const priv = secp256k1.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv, network);
}

// ============================================================================
//  RealStarknetSigner
// ============================================================================

export interface RealStarknetSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /** Network — defaults to "sepolia". */
  readonly network?: StarknetNetwork;
  /**
   * Optional balance reader — wired to a Starknet RPC `starknet_call` of the
   * ERC-20 `balanceOf` in production. If omitted, getBalance() returns 0
   * (offline-safe default). Returns the balance in the asset's smallest unit.
   */
  readonly balanceReader?: (input: {
    readonly address: string;
    readonly asset: string;
  }) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to Starknet RPC
   * `starknet_addInvokeTransaction` in production. If omitted, signAndSubmit()
   * returns the locally-computed signature + a deterministic mock tx hash
   * without hitting the network (offline-safe, version 0).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly asset: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly txHash: string;
    readonly signer: string;
  }) => Promise<{ readonly txHash?: string; readonly explorerUrl?: string }>;
}

export interface StarknetSignResult {
  /** Compact ECDSA signature (hex, no 0x, 64-byte r||s) — verifiable offline. */
  readonly signature: string;
  /** sha256 of the canonical descriptor (hex) — stands in for the Starknet tx hash. */
  readonly txHash: string;
  readonly explorerUrl: string;
}

export class RealStarknetSigner {
  readonly address: string;
  readonly network: StarknetNetwork;
  readonly publicKeyHex: string;
  private readonly priv: Uint8Array;
  private readonly cfg: RealStarknetSignerConfig;

  constructor(cfg: RealStarknetSignerConfig = {}) {
    this.network = cfg.network ?? "sepolia";
    let kp: StarknetKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey, this.network);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex, this.network);
    } else {
      kp = generateStarknetKeypair(this.network);
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
  }

  /**
   * Sign a canonical Starknet transfer descriptor with secp256k1 ECDSA over a
   * sha256 digest. The signature is REAL and verifiable offline (compact
   * 64-byte r||s, low-S normalized); the `submit` hook (when present) assembles
   * + broadcasts the actual Starknet invoke transaction.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    asset: string;
    reference?: string;
    memo?: string;
  }): Promise<StarknetSignResult> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      asset: input.asset,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const digest = sha256(new TextEncoder().encode(descriptor));
    // lowS:true → canonical signatures.
    const sig = secp256k1.sign(digest, this.priv, { lowS: true });
    const signature = toHex(sig.toCompactRawBytes()); // 64-byte r||s
    const txHash = "0x" + toHex(digest);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        asset: input.asset,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        txHash,
        signer: this.address,
      });
      const finalTx = res.txHash ?? txHash;
      return {
        signature,
        txHash: finalTx,
        explorerUrl: res.explorerUrl ?? this.explorerUrl(finalTx),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred (version 0).
    return { signature, txHash, explorerUrl: this.explorerUrl(txHash) };
  }

  async getBalance(asset: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader({ address: this.address, asset });
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

  private explorerUrl(txHash: string): string {
    return `${explorerBase(this.network)}/tx/${txHash}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Starknet transfer.
 * Stable field ordering so the same intent always yields the same digest +
 * signature. Stands in for a fully-serialized Starknet invoke calldata in the
 * offline path.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  asset: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `starknet-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `asset=${fields.asset}`,
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
