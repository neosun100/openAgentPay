/**
 * RealHederaSigner — Ed25519 signer for Hedera, backed by @noble/curves.
 * ============================================================================
 *
 * Hedera uses Ed25519 keys (it also supports ECDSA secp256k1, but Ed25519 is
 * the canonical/native key type and what the SDK generates by default). This
 * signer holds a real Ed25519 keypair and signs the canonical Hedera transfer
 * descriptor. No `@hashgraph/sdk` dependency — conformance + unit tests run
 * fully offline with real cryptography.
 *
 * Why not @hashgraph/sdk?
 *   - Conformance + unit tests must run offline, zero heavyweight deps.
 *   - The cryptographic identity (seed → Ed25519 keypair → DER private key →
 *     mock account id) is fully real here; only the on-network *broadcast*
 *     (TransferTransaction → consensus node) needs a live Hedera node + a
 *     network-assigned account id. We keep that pluggable via the optional
 *     `submit` hook so production can wire @hashgraph/sdk without touching
 *     this file.
 *
 * Account-id model:
 *   - Real Hedera account ids ("0.0.<num>") are assigned by the network at
 *     account-creation time — you cannot derive them from a key offline.
 *   - For offline/testnet-shaped operation we derive a DETERMINISTIC mock
 *     account id from the public key ("0.0." + a number derived from the
 *     pubkey hash). Production overrides this with the real assigned id via
 *     RealHederaSignerConfig.accountId.
 *
 * Key material:
 *   - 32-byte Ed25519 seed.
 *   - DER-encoded private key string (PKCS#8-ish prefix used by Hedera SDK):
 *       "302e020100300506032b657004220420" + seed(32 bytes hex)
 *   - Public key hex (32 bytes), stored in providerMetadata.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";

// ============================================================================
//  Constants
// ============================================================================

/** DER prefix Hedera uses for Ed25519 private keys (PKCS#8 + Ed25519 OID). */
export const HEDERA_ED25519_DER_PREFIX = "302e020100300506032b657004220420";
/** DER prefix Hedera uses for Ed25519 public keys (SubjectPublicKeyInfo). */
export const HEDERA_ED25519_PUB_DER_PREFIX = "302a300506032b6570032100";

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface HederaKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly seedHex: string;
  /**
   * DER-encoded private key string, exactly as `@hashgraph/sdk`'s
   * `PrivateKey.toStringDer()` emits for an Ed25519 key:
   *   "302e020100300506032b657004220420" + seedHex
   */
  readonly privateKeyDer: string;
  /** 32-byte Ed25519 public key, hex (no 0x). */
  readonly publicKeyHex: string;
  /** DER-encoded public key string (SubjectPublicKeyInfo). */
  readonly publicKeyDer: string;
  /**
   * Deterministic MOCK account id ("0.0.<num>") derived from the pubkey.
   * Real account ids are network-assigned; this is the offline stand-in.
   */
  readonly accountId: string;
}

/** Generate a fresh, cryptographically-random Hedera Ed25519 keypair. */
export function generateHederaKeypair(): HederaKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Reconstruct a keypair from a 32-byte seed. */
export function keypairFromSeed(seed: Uint8Array): HederaKeypair {
  if (seed.length !== 32) {
    throw new Error(`Hedera Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  const seedHex = toHex(seed);
  const publicKeyHex = toHex(pubkey);
  return {
    seedHex,
    privateKeyDer: derivePrivateKeyDer(seed),
    publicKeyHex,
    publicKeyDer: HEDERA_ED25519_PUB_DER_PREFIX + publicKeyHex,
    accountId: deriveMockAccountId(pubkey),
  };
}

/**
 * Load a keypair from a DER-encoded Hedera Ed25519 private key string.
 * Accepts the canonical "302e020100300506032b657004220420"-prefixed form,
 * or a bare 32-byte seed hex (with/without 0x).
 */
export function keypairFromDer(privateKey: string): HederaKeypair {
  const clean = privateKey.toLowerCase().replace(/^0x/, "");
  let seedHex: string;
  if (clean.startsWith(HEDERA_ED25519_DER_PREFIX)) {
    seedHex = clean.slice(HEDERA_ED25519_DER_PREFIX.length);
  } else {
    seedHex = clean;
  }
  if (seedHex.length !== 64) {
    throw new Error(
      `Hedera DER private key must contain a 32-byte seed, got ${seedHex.length / 2} bytes`
    );
  }
  return keypairFromSeed(hexToBytes(seedHex));
}

/**
 * Derive the DER-encoded Ed25519 private key string for a 32-byte seed.
 * Format matches @hashgraph/sdk PrivateKey.toStringDer():
 *   "302e020100300506032b657004220420" + seedHex
 */
export function derivePrivateKeyDer(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  }
  return HEDERA_ED25519_DER_PREFIX + toHex(seed);
}

/**
 * Deterministic mock account id from a public key. Real Hedera account ids are
 * network-assigned; this derives a stable "0.0.<num>" for offline operation by
 * hashing the pubkey and mapping the leading bytes into a realistic id range.
 *
 * Range: [1001, 1001 + ~4.29e9) — above the system/reserved range (< 1000),
 * shaped like real mainnet/testnet account numbers.
 */
export function deriveMockAccountId(pubkey: Uint8Array): string {
  const h = sha256(pubkey);
  // Take 4 bytes → uint32, offset past reserved system accounts.
  const n =
    ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  const num = 1001 + (n % 4_000_000_000);
  return `0.0.${num}`;
}

// ============================================================================
//  RealHederaSigner
// ============================================================================

export interface RealHederaSignerConfig {
  /** DER-encoded Ed25519 private key string, or bare 32-byte seed hex. */
  readonly privateKeyDer?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /**
   * Real network-assigned account id ("0.0.<num>"). If omitted, the
   * deterministic mock derived from the pubkey is used.
   */
  readonly accountId?: string;
  /** Hedera network for explorer URLs + network labels. */
  readonly network?: "mainnet" | "testnet" | "previewnet";
  /**
   * Optional balance reader — wired to a Hedera Mirror Node REST query in
   * production. If omitted, getBalance() returns 0n (offline-safe default).
   */
  readonly balanceReader?: (
    accountId: string,
    tokenId?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to @hashgraph/sdk TransferTransaction in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly from: string;
    readonly to: string;
    readonly amountAtomic: string;
    readonly tokenId?: string;
    readonly memo?: string;
    readonly nonce?: string;
    readonly signatureHex: string;
    readonly signer: string;
  }) => Promise<{ readonly consensusTxId?: string; readonly explorerUrl?: string }>;
}

export class RealHederaSigner {
  /** "0.0.<num>" account id (network-assigned or deterministic mock). */
  readonly accountId: string;
  /** 32-byte Ed25519 public key hex (no 0x). */
  readonly publicKeyHex: string;
  /** DER-encoded private key string. */
  readonly privateKeyDer: string;
  private readonly seed: Uint8Array;
  private readonly pubkey: Uint8Array;
  private readonly cfg: RealHederaSignerConfig;
  private readonly network: "mainnet" | "testnet" | "previewnet";

  constructor(cfg: RealHederaSignerConfig = {}) {
    let kp: HederaKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.privateKeyDer) {
      kp = keypairFromDer(cfg.privateKeyDer);
    } else {
      kp = generateHederaKeypair();
    }
    this.seed = hexToBytes(kp.seedHex);
    this.pubkey = hexToBytes(kp.publicKeyHex);
    this.publicKeyHex = kp.publicKeyHex;
    this.privateKeyDer = kp.privateKeyDer;
    this.accountId = cfg.accountId ?? kp.accountId;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Sign a deterministic descriptor derived from the transfer intent with a
   * real Ed25519 signature. The production `submit` hook assembles +
   * broadcasts the actual TransferTransaction; the signature here is the
   * agent's cryptographic authorization, returned hex (Hedera signatures are
   * raw 64-byte Ed25519, conventionally hex-encoded).
   */
  async signAndSubmit(input: {
    to: string;
    amountAtomic: string;
    tokenId?: string;
    memo?: string;
    nonce?: string;
  }): Promise<{ signatureHex: string; consensusTxId?: string; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.accountId,
      to: input.to,
      amountAtomic: input.amountAtomic,
      ...(input.tokenId !== undefined ? { tokenId: input.tokenId } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    });
    const msg = sha256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signatureHex = toHex(sigBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        from: this.accountId,
        to: input.to,
        amountAtomic: input.amountAtomic,
        ...(input.tokenId !== undefined ? { tokenId: input.tokenId } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
        signatureHex,
        signer: this.accountId,
      });
      const consensusTxId =
        res.consensusTxId ?? this.syntheticTxId(input.nonce ?? signatureHex);
      return {
        signatureHex,
        consensusTxId,
        explorerUrl: res.explorerUrl ?? this.explorerUrl(consensusTxId),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred. We mint a
    // synthetic-but-well-formed consensus tx id so downstream receipts are
    // shaped like real ones.
    const consensusTxId = this.syntheticTxId(input.nonce ?? signatureHex);
    return {
      signatureHex,
      consensusTxId,
      explorerUrl: this.explorerUrl(consensusTxId),
    };
  }

  async getBalance(tokenId?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.accountId, tokenId);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex.replace(/^0x/, ""));
      const msg = sha256(new TextEncoder().encode(descriptor));
      return ed25519.verify(sig, msg, this.pubkey);
    } catch {
      return false;
    }
  }

  /**
   * Hedera consensus tx ids look like "0.0.<payer>@<seconds>.<nanos>".
   * Deterministically derived from the account id + a per-tx salt so the same
   * intent yields the same id offline.
   */
  private syntheticTxId(salt: string): string {
    const h = sha256(new TextEncoder().encode(`${this.accountId}:${salt}`));
    const seconds = 1_700_000_000 + (((h[0]! << 16) | (h[1]! << 8) | h[2]!) >>> 0) % 100_000_000;
    const nanos = (((h[3]! << 16) | (h[4]! << 8) | h[5]!) >>> 0) % 1_000_000_000;
    return `${this.accountId}@${seconds}.${nanos.toString().padStart(9, "0")}`;
  }

  private explorerUrl(txId: string): string {
    // HashScan uses URL-encoded tx ids.
    const net = this.network === "mainnet" ? "mainnet" : this.network;
    return `https://hashscan.io/${net}/transaction/${encodeURIComponent(txId)}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Hedera transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  tokenId?: string;
  memo?: string;
  nonce?: string;
}): string {
  const parts = [
    `hedera-hcs/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `token=${fields.tokenId ?? "HBAR"}`,
    `memo=${fields.memo ?? ""}`,
    `nonce=${fields.nonce ?? ""}`,
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
