/**
 * RealAptosSigner — Ed25519 signer backed by @noble/curves, no @aptos-labs/ts-sdk.
 * ============================================================================
 *
 * Aptos cryptographic identity (single-Ed25519 authentication key):
 *
 *   private key  = 32-byte Ed25519 seed         → "0x" + 64 hex
 *   public key   = ed25519.getPublicKey(seed)   → 32 bytes
 *   auth key     = sha3_256( pubkey || 0x00 )    (0x00 = Single-Ed25519 scheme byte)
 *   address      = auth key (full 32 bytes)      → "0x" + 64 hex
 *
 * This matches what Petra / Pontem / the Aptos CLI display for a fresh account
 * (before any key rotation, account address === authentication key).
 *
 * Why not @aptos-labs/ts-sdk?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (keypair → address → signature) is fully real
 *     here; only the RPC *submit* needs a live fullnode. We keep that pluggable
 *     via the optional `submit` hook so production can wire the Aptos SDK's
 *     `signAndSubmitTransaction` without changing this file.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";

import type { AptosSigner } from "./connector.js";

// Single-key Ed25519 authentication scheme identifier byte (Aptos spec).
const SINGLE_ED25519_SCHEME = 0x00;

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface AptosKeypair {
  /** 32-byte Ed25519 seed (private key), "0x" + 64 hex. */
  readonly privateKeyHex: string;
  /** 32-byte Ed25519 public key, "0x" + 64 hex. */
  readonly publicKeyHex: string;
  /** Account address = authentication key, "0x" + 64 hex. */
  readonly address: string;
}

/**
 * Generate a fresh, cryptographically-random Aptos keypair.
 * The address is a real sha3_256-derived authentication key, identical in
 * shape to what an Aptos devnet faucet would fund.
 */
export function generateAptosKeypair(): AptosKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Derive the Aptos authentication key / address from a 32-byte public key. */
export function authKeyFromPublicKey(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) {
    throw new Error(`Aptos pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  const input = new Uint8Array(pubkey.length + 1);
  input.set(pubkey, 0);
  input[pubkey.length] = SINGLE_ED25519_SCHEME; // append scheme byte 0x00
  const authKey = sha3_256(input); // 32 bytes
  return "0x" + toHex(authKey);
}

/** Reconstruct a keypair from a 32-byte seed (private key). */
export function keypairFromSeed(seed: Uint8Array): AptosKeypair {
  if (seed.length !== 32) {
    throw new Error(`Aptos seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  return {
    privateKeyHex: "0x" + toHex(seed),
    publicKeyHex: "0x" + toHex(pubkey),
    address: authKeyFromPublicKey(pubkey),
  };
}

/** Load a keypair from a hex private key ("0x"-prefixed or bare, 64 hex chars). */
export function keypairFromPrivateKeyHex(privateKeyHex: string): AptosKeypair {
  const seed = hexToBytes(privateKeyHex);
  if (seed.length !== 32) {
    throw new Error(
      `Aptos private key must be 32 bytes (64 hex chars), got ${seed.length}`
    );
  }
  return keypairFromSeed(seed);
}

// ============================================================================
//  RealAptosSigner
// ============================================================================

export interface RealAptosSignerConfig {
  /** Hex private key ("0x" + 64 hex, or bare 64 hex). */
  readonly privateKeyHex?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /**
   * Optional balance reader — wired to an Aptos fullnode REST endpoint in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    coinType?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to @aptos-labs/ts-sdk
   * signAndSubmitTransaction in production. If omitted, signAndSubmit()
   * returns the locally-computed signature without hitting the network
   * (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly coinType?: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly publicKey: string;
    readonly signer: string;
  }) => Promise<{ readonly version?: number; readonly explorerUrl?: string }>;
  /** Network for explorer URLs. */
  readonly network?: "mainnet" | "testnet" | "devnet";
}

export class RealAptosSigner implements AptosSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealAptosSignerConfig;
  private readonly network: "mainnet" | "testnet" | "devnet";

  constructor(cfg: RealAptosSignerConfig = {}) {
    let kp: AptosKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromPrivateKeyHex(cfg.privateKeyHex);
    } else {
      kp = generateAptosKeypair();
    }
    this.seed = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Sign a deterministic message derived from the transfer intent. This is a
   * real Ed25519 signature over the canonical Aptos transfer descriptor.
   * The production `submit` hook is responsible for assembling + broadcasting
   * the actual Move `coin::transfer` transaction; the signature here is the
   * agent's cryptographic authorization, returned "0x"-hex (Aptos sig form).
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    coinType?: string;
    reference?: string;
    memo?: string;
  }): Promise<{ signature: string; version?: number; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.coinType !== undefined ? { coinType: input.coinType } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = sha3_256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signature = "0x" + toHex(sigBytes); // "0x"-hex — matches Aptos sig form

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.coinType !== undefined ? { coinType: input.coinType } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        publicKey: this.publicKeyHex,
        signer: this.address,
      });
      return {
        signature,
        ...(res.version !== undefined ? { version: res.version } : {}),
        explorerUrl: res.explorerUrl ?? this.explorerUrl(signature),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return {
      signature,
      version: 0,
      explorerUrl: this.explorerUrl(signature),
    };
  }

  async getBalance(coinType?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, coinType);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msg = sha3_256(new TextEncoder().encode(descriptor));
      const pubkey = hexToBytes(this.publicKeyHex);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(sig: string): string {
    return `https://explorer.aptoslabs.com/txn/${sig}?network=${this.network}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of an Aptos coin transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  coinType?: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `aptos-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `coin=${fields.coinType ?? "0x1::aptos_coin::AptosCoin"}`,
    `ref=${fields.reference ?? ""}`,
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
