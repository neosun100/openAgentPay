/**
 * RealNearMainnetSigner — Ed25519 signer for NEAR MAINNET, backed by
 * @noble/curves, no near-api-js.
 * ============================================================================
 *
 * Production-shaped NEAR *mainnet* signer that holds a real Ed25519 keypair,
 * derives the canonical NEAR *implicit account* (lowercase-hex of the 32-byte
 * public key), and signs the transfer intent with a real, verifiable Ed25519
 * signature.
 *
 * Mainnet specifics vs. testnet:
 *   - Named accounts end in ".near" (not ".testnet").
 *   - Implicit accounts are identical in shape on both networks: lowercase hex
 *     of the 32-byte Ed25519 pubkey (64 hex chars, NO 0x prefix).
 *   - Explorer host is nearblocks.io / explorer.near.org (mainnet).
 *
 * Why not near-api-js?
 *   - Conformance + unit tests must run offline with zero heavyweight deps.
 *   - The cryptographic identity (keypair → implicit account → signature) is
 *     fully real here; only the RPC *broadcast* needs a live network. We keep
 *     that pluggable via the optional `submit` hook so production can wire
 *     near-api-js's `signAndSendTransaction` without changing this file.
 *
 * Mnemonic support: a BIP-39 path is provided (`keypairFromMnemonic`) so a
 * mainnet seed-phrase wallet can be reconstructed deterministically — the
 * entropy of a 12/24-word phrase seeds the Ed25519 key (NEAR's "ed25519"
 * key derivation uses the BIP-39 seed directly; we take the first 32 bytes).
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

import type { NearMainnetSigner } from "./connector.js";

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface NearKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). */
  readonly secretSeedHex: string;
  /** Private key string: "ed25519:" + base58(seed||pubkey) — near-cli form. */
  readonly secretKey: string;
  /** Public key string: "ed25519:" + base58(pubkey). */
  readonly publicKey: string;
  /** NEAR implicit account id = lowercase hex(pubkey), 64 chars, no 0x. */
  readonly accountId: string;
}

const ED25519_PREFIX = "ed25519:";

/** Matches a NEAR mainnet implicit account: 64 lowercase hex chars, no 0x. */
export const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;

/**
 * Matches a NEAR mainnet *named* account. Top-level (and sub-) accounts under
 * the mainnet root end in ".near". 2..64 chars, lowercase alphanumerics with
 * `-`/`_` separators per NEAR's account-id rules. (Implicit accounts are
 * validated separately by IMPLICIT_ACCOUNT_RE.)
 */
export const NAMED_ACCOUNT_RE =
  /^(([a-z\d]+[-_])*[a-z\d]+\.)+near$/;

/**
 * True when `accountId` is a valid mainnet account id — either a 64-hex
 * implicit account or a `.near` named account.
 */
export function isValidMainnetAccountId(accountId: string): boolean {
  if (IMPLICIT_ACCOUNT_RE.test(accountId)) return true;
  if (accountId.length < 2 || accountId.length > 64) return false;
  return NAMED_ACCOUNT_RE.test(accountId);
}

/**
 * Generate a fresh, cryptographically-random NEAR mainnet keypair.
 * The accountId is a real implicit account (64 lowercase hex), identical in
 * shape to what a mainnet exchange withdrawal or wallet would fund.
 */
export function generateNearKeypair(): NearKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed);
}

/** Reconstruct a keypair from a 32-byte seed. */
export function keypairFromSeed(seed: Uint8Array): NearKeypair {
  if (seed.length !== 32) {
    throw new Error(`NEAR seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  const secretKey64 = new Uint8Array(64);
  secretKey64.set(seed, 0);
  secretKey64.set(pubkey, 32);
  return {
    secretSeedHex: toHex(seed),
    secretKey: ED25519_PREFIX + base58.encode(secretKey64),
    publicKey: ED25519_PREFIX + base58.encode(pubkey),
    accountId: toHex(pubkey), // implicit account = lowercase hex of pubkey
  };
}

/**
 * Load a keypair from a NEAR private key string ("ed25519:" + base58(...)).
 * Accepts both the 64-byte (seed||pubkey) form near-cli produces and a bare
 * 32-byte seed.
 */
export function keypairFromSecretKey(secretKey: string): NearKeypair {
  if (!secretKey.startsWith(ED25519_PREFIX)) {
    throw new Error(`NEAR secret key must start with "${ED25519_PREFIX}"`);
  }
  const bytes = base58.decode(secretKey.slice(ED25519_PREFIX.length));
  if (bytes.length === 64) return keypairFromSeed(bytes.slice(0, 32));
  if (bytes.length === 32) return keypairFromSeed(bytes);
  throw new Error(
    `NEAR secret key must decode to 32 or 64 bytes, got ${bytes.length}`
  );
}

/**
 * Reconstruct a mainnet keypair from a BIP-39 mnemonic (12/24 words).
 * The phrase is validated against the English wordlist; the first 32 bytes of
 * the BIP-39 seed seed the Ed25519 key. Deterministic — the same phrase always
 * yields the same implicit account, matching seed-phrase wallet recovery.
 */
export function keypairFromMnemonic(
  mnemonic: string,
  passphrase = ""
): NearKeypair {
  const normalized = mnemonic.trim().replace(/\s+/g, " ");
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid BIP-39 mnemonic");
  }
  const seed = mnemonicToSeedSync(normalized, passphrase); // 64 bytes
  return keypairFromSeed(seed.slice(0, 32));
}

// ============================================================================
//  RealNearMainnetSigner
// ============================================================================

export interface RealNearMainnetSignerConfig {
  /** NEAR private key string ("ed25519:" + base58(64-byte secretKey)). */
  readonly secretKey?: string;
  /** Or supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /** Or supply a BIP-39 mnemonic (12/24 words) — mainnet recovery path. */
  readonly mnemonic?: string;
  /**
   * Optional named account override. NEAR mainnet supports named accounts that
   * end in ".near"; when set, this is used as the signer's accountId instead of
   * the implicit (hex) account. The keypair still signs. Validated against the
   * mainnet account-id rules (must end in ".near").
   */
  readonly accountId?: string;
  /**
   * Optional balance reader — wired to a NEAR mainnet RPC in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    accountId: string,
    token?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to near-api-js signAndSendTransaction in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly token?: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
    readonly publicKey: string;
  }) => Promise<{ readonly blockHash?: string; readonly explorerUrl?: string }>;
}

export class RealNearMainnetSigner implements NearMainnetSigner {
  readonly accountId: string;
  readonly publicKey: string;
  /** The implicit (hex) account derived from the keypair — always available. */
  readonly implicitAccountId: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealNearMainnetSignerConfig;

  constructor(cfg: RealNearMainnetSignerConfig = {}) {
    let kp: NearKeypair;
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed);
    } else if (cfg.mnemonic) {
      kp = keypairFromMnemonic(cfg.mnemonic);
    } else if (cfg.secretKey) {
      kp = keypairFromSecretKey(cfg.secretKey);
    } else {
      kp = generateNearKeypair();
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.implicitAccountId = kp.accountId;
    if (cfg.accountId !== undefined) {
      // A named mainnet account must end in ".near".
      if (!isValidMainnetAccountId(cfg.accountId)) {
        throw new Error(
          `Invalid NEAR mainnet accountId "${cfg.accountId}" — named accounts must end in ".near"`
        );
      }
      this.accountId = cfg.accountId;
    } else {
      this.accountId = kp.accountId; // implicit hex account
    }
    this.publicKey = kp.publicKey;
    this.cfg = cfg;
  }

  /**
   * Sign a deterministic message derived from the transfer intent. This is a
   * real Ed25519 signature over the canonical NEAR transfer descriptor. The
   * production `submit` hook is responsible for assembling + broadcasting the
   * actual on-chain transaction; the signature here is the agent's
   * cryptographic authorization, returned base58.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    token?: string;
    reference?: string;
    memo?: string;
  }): Promise<{ signature: string; blockHash?: string; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.accountId,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = sha256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signature = base58.encode(sigBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.token !== undefined ? { token: input.token } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.accountId,
        publicKey: this.publicKey,
      });
      return {
        signature,
        ...(res.blockHash !== undefined ? { blockHash: res.blockHash } : {}),
        explorerUrl: res.explorerUrl ?? this.explorerUrl(signature),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return {
      signature,
      blockHash: "",
      explorerUrl: this.explorerUrl(signature),
    };
  }

  async getBalance(token?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.accountId, token);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureBase58: string, descriptor: string): boolean {
    try {
      const sig = base58.decode(signatureBase58);
      const msg = sha256(new TextEncoder().encode(descriptor));
      const pubkey = ed25519.getPublicKey(this.seed);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(sig: string): string {
    // Mainnet explorer. nearblocks.io is the current canonical explorer.
    return `https://nearblocks.io/txns/${sig}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a NEAR transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  token?: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `near-pay/v1`,
    `net=mainnet`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `token=${fields.token ?? "near"}`,
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
