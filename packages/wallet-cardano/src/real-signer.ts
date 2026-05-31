/**
 * RealCardanoSigner — Ed25519 (Shelley) signer backed by @noble/curves, no
 * @emurgo/cardano-serialization-lib / lucid / mesh deps.
 * ============================================================================
 *
 * The Cardano analogue of RealSolanaSigner. It holds a real Ed25519 keypair,
 * derives the canonical Shelley enterprise testnet address
 *
 *     addr_test1… = bech32("addr_test", header_byte || blake2b224(pubkey))
 *
 * with header_byte = 0x60 for an enterprise (no-stake) testnet address, and
 * signs the transfer descriptor with Ed25519.
 *
 * Why not cardano-serialization-lib?
 *   - Conformance + unit tests must run offline with zero heavyweight (WASM)
 *     deps.
 *   - The cryptographic identity (keypair → address → signature) is fully
 *     real here; only the on-chain *broadcast* (Tx assembly + submit via a
 *     node / Blockfrost) needs a live network. We keep that pluggable via the
 *     optional `submit` hook so production can wire CSL/Blockfrost without
 *     changing this file.
 *
 * Key material:
 *   - 32-byte Ed25519 seed (Shelley payment key, simplified — real wallets use
 *     CIP-1852 BIP32-Ed25519 HD derivation m/1852'/1815'/0'/0/0; we keep a
 *     flat Ed25519 key here, which yields a valid, spendable enterprise
 *     address with an identical on-the-wire shape).
 *   - Address = bech32("addr_test", 0x60 || blake2b224(pubkey)).
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2";
import { bech32 } from "@scure/base";

// ============================================================================
//  Constants — Shelley address header bytes
// ============================================================================

/**
 * Address header is a single byte: high nibble = address type, low nibble =
 * network id. Enterprise (payment key only, no staking part) = type 0b0110.
 *   - testnet  network id = 0  → 0b0110_0000 = 0x60  (addr_test1…)
 *   - mainnet  network id = 1  → 0b0110_0001 = 0x61  (addr1…)
 */
export const ENTERPRISE_TESTNET_HEADER = 0x60;
export const ENTERPRISE_MAINNET_HEADER = 0x61;

/** bech32 human-readable prefixes. */
export const TESTNET_HRP = "addr_test";
export const MAINNET_HRP = "addr";

/** blake2b-224 → 28-byte digest (the Cardano credential hash size). */
const BLAKE2B_224_BYTES = 28;

export type CardanoNetwork = "testnet" | "mainnet";

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface CardanoKeypair {
  /** 32-byte Ed25519 seed / payment signing key (hex, no 0x). */
  readonly secretSeedHex: string;
  /** 32-byte Ed25519 public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** 28-byte blake2b-224(pubkey) payment-key-hash (hex, no 0x). */
  readonly paymentKeyHashHex: string;
  /** bech32 enterprise address (addr_test1… on testnet, addr1… on mainnet). */
  readonly address: string;
  /** Network the address was minted for. */
  readonly network: CardanoNetwork;
}

/**
 * Generate a fresh, cryptographically-random Cardano keypair + canonical
 * Shelley enterprise address. Fully offline; no faucet/network involved.
 */
export function generateCardanoKeypair(
  network: CardanoNetwork = "testnet"
): CardanoKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed, network);
}

/** Reconstruct a keypair from a 32-byte Ed25519 seed. */
export function keypairFromSeed(
  seed: Uint8Array,
  network: CardanoNetwork = "testnet"
): CardanoKeypair {
  if (seed.length !== 32) {
    throw new Error(`Cardano Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  const keyHash = paymentKeyHash(pubkey);
  return {
    secretSeedHex: toHex(seed),
    publicKeyHex: toHex(pubkey),
    paymentKeyHashHex: toHex(keyHash),
    address: enterpriseAddress(keyHash, network),
    network,
  };
}

/** Load a keypair from a hex-encoded 32-byte seed (with or without 0x). */
export function keypairFromHex(
  secretSeedHex: string,
  network: CardanoNetwork = "testnet"
): CardanoKeypair {
  const bytes = hexToBytes(secretSeedHex);
  if (bytes.length !== 32) {
    throw new Error(
      `Cardano secret seed hex must decode to 32 bytes, got ${bytes.length}`
    );
  }
  return keypairFromSeed(bytes, network);
}

/**
 * blake2b-224 of the raw Ed25519 public key → the 28-byte payment key hash
 * (the credential that goes into a Shelley address).
 */
export function paymentKeyHash(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) {
    throw new Error(
      `Cardano Ed25519 pubkey must be 32 bytes, got ${publicKey.length}`
    );
  }
  return blake2b(publicKey, { dkLen: BLAKE2B_224_BYTES });
}

/**
 * Encode a Shelley enterprise address:
 *   bech32(hrp, header_byte || paymentKeyHash)
 * where hrp + header are network-specific.
 */
export function enterpriseAddress(
  keyHash: Uint8Array,
  network: CardanoNetwork = "testnet"
): string {
  if (keyHash.length !== BLAKE2B_224_BYTES) {
    throw new Error(
      `payment key hash must be ${BLAKE2B_224_BYTES} bytes, got ${keyHash.length}`
    );
  }
  const header =
    network === "testnet"
      ? ENTERPRISE_TESTNET_HEADER
      : ENTERPRISE_MAINNET_HEADER;
  const hrp = network === "testnet" ? TESTNET_HRP : MAINNET_HRP;
  const payload = new Uint8Array(1 + BLAKE2B_224_BYTES);
  payload[0] = header;
  payload.set(keyHash, 1);
  // Cardano addresses can exceed bech32's default 90-char limit; enterprise
  // addresses are 29 payload bytes (~58 char output) so the default holds, but
  // we pass an explicit generous limit for safety/future base addresses.
  return bech32.encode(hrp, bech32.toWords(payload), 256);
}

/**
 * Decode a Shelley enterprise address back into { network, keyHash }.
 * Throws on malformed input. Used in tests + audits.
 */
export function decodeEnterpriseAddress(address: string): {
  readonly network: CardanoNetwork;
  readonly header: number;
  readonly keyHashHex: string;
} {
  const { prefix, words } = bech32.decode(address as `${string}1${string}`, 256);
  const bytes = bech32.fromWords(words);
  const header = bytes[0];
  if (header === undefined) {
    throw new Error("Cardano address payload is empty");
  }
  const network: CardanoNetwork = prefix === TESTNET_HRP ? "testnet" : "mainnet";
  return {
    network,
    header,
    keyHashHex: toHex(bytes.slice(1)),
  };
}

// ============================================================================
//  RealCardanoSigner
// ============================================================================

export interface RealCardanoSignerConfig {
  /** Hex-encoded 32-byte Ed25519 seed (with/without 0x). */
  readonly secretSeedHex?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /** Network (default "testnet"). */
  readonly network?: CardanoNetwork;
  /**
   * Optional balance reader — wired to Blockfrost / a cardano-node in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: string, asset?: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to CSL Tx assembly + Blockfrost
   * `/tx/submit` in production. If omitted, signAndSubmit() returns the
   * locally-computed signature without hitting the network (offline-safe,
   * deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly asset?: string;
    readonly memo?: string;
    readonly signatureHex: string;
    readonly signer: string;
    readonly publicKeyHex: string;
  }) => Promise<{ readonly txHash?: string; readonly slot?: number }>;
}

export class RealCardanoSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  readonly network: CardanoNetwork;
  private readonly seed: Uint8Array;
  private readonly cfg: RealCardanoSignerConfig;

  constructor(cfg: RealCardanoSignerConfig = {}) {
    const network = cfg.network ?? "testnet";
    let kp: CardanoKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed, network);
    } else if (cfg.secretSeedHex) {
      kp = keypairFromHex(cfg.secretSeedHex, network);
    } else {
      kp = generateCardanoKeypair(network);
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.network = network;
    this.cfg = cfg;
  }

  /**
   * Sign a deterministic descriptor derived from the transfer intent. This is
   * a real Ed25519 signature over blake2b-256(descriptor) — mirroring how
   * Cardano signs the blake2b-256 transaction body hash. Returned as hex
   * (64-byte R||S). The production `submit` hook assembles + broadcasts the
   * actual on-chain transaction.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    asset?: string;
    memo?: string;
  }): Promise<{
    signatureHex: string;
    txHash?: string;
    slot?: number;
    explorerUrl?: string;
  }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      network: this.network,
      ...(input.asset !== undefined ? { asset: input.asset } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = blake2b(new TextEncoder().encode(descriptor), { dkLen: 32 });
    const sigBytes = ed25519.sign(msg, this.seed);
    const signatureHex = toHex(sigBytes); // 64-byte R||S, hex

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.asset !== undefined ? { asset: input.asset } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signatureHex,
        signer: this.address,
        publicKeyHex: this.publicKeyHex,
      });
      return {
        signatureHex,
        ...(res.txHash !== undefined ? { txHash: res.txHash } : {}),
        ...(res.slot !== undefined ? { slot: res.slot } : {}),
        ...(res.txHash !== undefined
          ? { explorerUrl: this.explorerUrl(res.txHash) }
          : {}),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return { signatureHex };
  }

  async getBalance(asset = "lovelace"): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, asset);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msg = blake2b(new TextEncoder().encode(descriptor), { dkLen: 32 });
      const pubkey = hexToBytes(this.publicKeyHex);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(txHash: string): string {
    const sub = this.network === "testnet" ? "preprod." : "";
    return `https://${sub}cardanoscan.io/transaction/${txHash}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Cardano transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  network: CardanoNetwork;
  asset?: string;
  memo?: string;
}): string {
  const parts = [
    `cardano-pay/v1`,
    `network=${fields.network}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `asset=${fields.asset ?? "lovelace"}`,
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
