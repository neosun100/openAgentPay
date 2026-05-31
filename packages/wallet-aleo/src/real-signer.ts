/**
 * RealAleoSigner — ed25519 identity + bech32m "aleo1…" address codec.
 * ============================================================================
 *
 * Aleo is a privacy-focused L1 whose *production* cryptography is heavy:
 * Schnorr signatures over the BLS12-377 scalar field, Poseidon hashing, and
 * a zkSNARK account model (account private key → view key → address). Bundling
 * a full Aleo prover/signer is impractical for an offline, dependency-light
 * WalletConnector whose contract is "real keypair → real address → real,
 * verifiable signature".
 *
 * So this is a **testnet-shaped approximation**: we generate a real ed25519
 * keypair in-process and encode the address as
 *
 *     bech32m("aleo", sha256(ed25519_pubkey)[0..20])
 *
 * which yields a canonical Aleo-shaped "aleo1…" string. The signature is a
 * real ed25519 signature over a canonical transfer descriptor — fully
 * verifiable offline with verify(), and a tampered descriptor fails. The
 * WalletConnector contract + the 25-test conformance suite are what matters
 * here; chain-exact Aleo Schnorr/Poseidon crypto is deliberately out of scope
 * (swap the signer impl behind this class for production without touching the
 * connector). Settlement (proof generation + broadcast to an Aleo node) lives
 * behind the optional, pluggable `submit` hook so signing runs fully offline.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bech32m } from "@scure/base";

// ============================================================================
//  Network params
// ============================================================================

export type AleoNetwork = "testnet" | "mainnet";

/**
 * The bech32m human-readable prefix (HRP) for Aleo addresses. Aleo addresses
 * are bech32m-encoded with the literal HRP "aleo" → strings begin "aleo1…"
 * on every network (Aleo does not vary the HRP by network the way Bitcoin
 * does; the network is carried out-of-band).
 */
export const ALEO_HRP = "aleo" as const;

/** Address payload width in bytes (sha256(pubkey) truncated to 20 bytes). */
export const ALEO_ADDR_BYTES = 20;

// ============================================================================
//  bech32m "aleo1…" address codec
// ============================================================================

/**
 * Encode a 20-byte address program into a canonical Aleo-shaped bech32m
 * address: bech32m("aleo", program) → "aleo1…".
 */
export function aleoAddressEncode(program: Uint8Array): string {
  if (program.length !== ALEO_ADDR_BYTES) {
    throw new Error(
      `aleoAddressEncode expects a ${ALEO_ADDR_BYTES}-byte program, got ${program.length}`
    );
  }
  return bech32m.encode(ALEO_HRP, bech32m.toWords(program));
}

export interface AleoAddressDecoded {
  readonly hrp: string;
  readonly program: Uint8Array;
}

/**
 * Decode + verify an "aleo1…" bech32m address. Throws on a bad checksum,
 * a wrong HRP, or an unexpected payload length.
 */
export function aleoAddressDecode(address: string): AleoAddressDecoded {
  const { prefix, words } = bech32m.decode(
    address as `${string}1${string}`
  );
  if (prefix !== ALEO_HRP) {
    throw new Error(`Aleo address HRP must be "${ALEO_HRP}", got "${prefix}"`);
  }
  const program = bech32m.fromWords(words);
  if (program.length !== ALEO_ADDR_BYTES) {
    throw new Error(
      `decoded Aleo program must be ${ALEO_ADDR_BYTES} bytes, got ${program.length}`
    );
  }
  return { hrp: prefix, program: Uint8Array.from(program) };
}

// ============================================================================
//  Address derivation
// ============================================================================

/** The 20-byte address program = sha256(ed25519 pubkey)[0..20]. */
export function addressProgram(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey).slice(0, ALEO_ADDR_BYTES);
}

export interface AleoKeypair {
  /** 32-byte ed25519 private key / seed (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 32-byte ed25519 public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** 20-byte address program (hex). */
  readonly programHex: string;
  /** bech32m address — "aleo1…". */
  readonly address: string;
  readonly network: AleoNetwork;
}

/** Build a keypair from a 32-byte ed25519 private key (seed). */
export function keypairFromPrivateKey(
  priv: Uint8Array,
  network: AleoNetwork = "testnet"
): AleoKeypair {
  if (priv.length !== 32) {
    throw new Error(`Aleo private key must be 32 bytes, got ${priv.length}`);
  }
  const pub = ed25519.getPublicKey(priv);
  const program = addressProgram(pub);
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub),
    programHex: toHex(program),
    address: aleoAddressEncode(program),
    network,
  };
}

/** Reconstruct a keypair from a hex private key (with or without 0x). */
export function keypairFromHex(
  privateKeyHex: string,
  network: AleoNetwork = "testnet"
): AleoKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex), network);
}

/**
 * Generate a fresh, cryptographically-random Aleo keypair fully in-process.
 * The address is a real bech32m "aleo1…" string, identical in shape to one a
 * testnet faucet would fund.
 */
export function generateAleoKeypair(
  network: AleoNetwork = "testnet"
): AleoKeypair {
  const priv = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv, network);
}

// ============================================================================
//  RealAleoSigner
// ============================================================================

export interface RealAleoSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /** Network — defaults to "testnet". */
  readonly network?: AleoNetwork;
  /**
   * Optional balance reader — wired to an Aleo node/explorer API in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   * Returns the balance in microcredits.
   */
  readonly balanceReader?: (address: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to an Aleo node `transfer_public` /
   * `transfer_private` execution + broadcast in production. If omitted,
   * signAndSubmit() returns the locally-computed ed25519 signature + a
   * deterministic mock txid without hitting the network (offline-safe).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountMicrocredits: string;
    readonly asset: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly txid: string;
    readonly signer: string;
  }) => Promise<{ readonly txid?: string; readonly explorerUrl?: string }>;
}

export interface AleoSignResult {
  /** ed25519 signature (hex, no 0x, 64-byte) — verifiable offline. */
  readonly signature: string;
  /** sha256 of the canonical descriptor (hex) — stands in for the Aleo txid. */
  readonly txid: string;
  readonly explorerUrl: string;
}

export class RealAleoSigner {
  readonly address: string;
  readonly network: AleoNetwork;
  readonly publicKeyHex: string;
  private readonly priv: Uint8Array;
  private readonly cfg: RealAleoSignerConfig;

  constructor(cfg: RealAleoSignerConfig = {}) {
    this.network = cfg.network ?? "testnet";
    let kp: AleoKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey, this.network);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex, this.network);
    } else {
      kp = generateAleoKeypair(this.network);
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
  }

  /**
   * Sign a canonical Aleo transfer descriptor with ed25519. The signature is
   * REAL and verifiable offline (64-byte ed25519); the `submit` hook (when
   * present) generates the zk proof + broadcasts the actual Aleo transfer.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountMicrocredits: string;
    asset?: string;
    reference?: string;
    memo?: string;
  }): Promise<AleoSignResult> {
    const asset = input.asset ?? "ALEO";
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountMicrocredits: input.amountMicrocredits,
      asset,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = new TextEncoder().encode(descriptor);
    const sig = ed25519.sign(msg, this.priv);
    const signature = toHex(sig); // 64-byte ed25519
    const txid = toHex(sha256(msg));

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountMicrocredits: input.amountMicrocredits,
        asset,
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
   * Verify an ed25519 signature this signer produced over a descriptor — for
   * tests + audits. Recomputes nothing beyond the message bytes and checks
   * against the pubkey.
   */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const msg = new TextEncoder().encode(descriptor);
      const pub = ed25519.getPublicKey(this.priv);
      return ed25519.verify(hexToBytes(signatureHex), msg, pub);
    } catch {
      return false;
    }
  }

  private explorerUrl(txid: string): string {
    return `https://explorer.aleo.org/transaction/${txid}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of an Aleo credits transfer.
 * Stable field ordering so the same intent always yields the same digest +
 * signature. Stands in for a fully-serialized Aleo `transfer_public` execution
 * payload in the offline path.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountMicrocredits: string;
  asset: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `aleo-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `asset=${fields.asset}`,
    `amount_microcredits=${fields.amountMicrocredits}`,
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
