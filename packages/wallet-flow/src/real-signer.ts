/**
 * RealFlowSigner — secp256k1 (ECDSA) signer backed by @noble/curves, no @onflow/fcl.
 * ============================================================================
 *
 * Mirrors `RealTronSigner` / `RealSolanaSigner` but for the Flow chain model:
 *
 *   - Crypto:   secp256k1 ECDSA. Flow accounts support BOTH ECDSA_P256
 *               (secp256r1) and ECDSA_secp256k1; we use secp256k1 via
 *               @noble/curves for consistency with the rest of the monorepo
 *               (Tron/Bitcoin) and because @noble/curves' secp256k1 ships a
 *               battle-tested deterministic-k (RFC-6979) signer. Flow's on-chain
 *               account-key registration records the curve + hash algo, so a
 *               secp256k1 key is a first-class Flow account key.
 *
 *   - Address:  Flow account addresses are NOT derived from the public key.
 *               They are 8-byte (16-hex) values ASSIGNED by the chain when an
 *               account is created (via Flow's linear-code address generator).
 *               There is no offline pubkey→address derivation. For an offline,
 *               deterministic, well-formed mock we take sha256(pubkey)[:8] and
 *               render it as "0x" + 16 lowercase hex. The full secp256k1 public
 *               key hex is preserved in providerMetadata so a production
 *               deployment can register the key against a real chain-assigned
 *               address without changing identity.
 *
 *   - Asset:    FLOW (8 dp) + USDC (6 dp).
 *
 *   - Settlement: a Cadence `transferTokens` transaction — broadcast deferred
 *               behind the optional, pluggable `submit` hook (offline-safe).
 *
 * The cryptographic identity (keypair → signature) is fully REAL and offline.
 * Only the on-chain broadcast needs a live access node; that is kept in the
 * `submit` hook so production can wire @onflow/fcl's `mutate`/`send` without
 * touching this file.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";

// ============================================================================
//  Address codec — Flow's 8-byte (16-hex) chain-assigned account address
// ============================================================================

/** Number of bytes in a Flow account address (8 → 16 hex chars). */
export const FLOW_ADDRESS_BYTES = 8;

/** Regex a well-formed Flow address must satisfy: "0x" + exactly 16 hex chars. */
export const FLOW_ADDRESS_RE = /^0x[0-9a-f]{16}$/;

/**
 * Derive a deterministic, well-formed MOCK Flow address from a public key.
 *
 * Flow addresses are chain-assigned, so this is NOT how mainnet addresses are
 * produced — it gives every offline keypair a stable, syntactically-valid
 * "0x"+16-hex handle suitable for tests and the conformance suite. The mapping
 * is sha256(pubkey)[:8].
 */
export function pubkeyToMockAddress(publicKey: Uint8Array): string {
  const digest = sha256(publicKey);
  return "0x" + toHex(digest.slice(0, FLOW_ADDRESS_BYTES));
}

/** True iff `addr` is a syntactically-valid Flow address ("0x" + 16 hex). */
export function isValidFlowAddress(addr: string): boolean {
  return FLOW_ADDRESS_RE.test(addr);
}

/** Normalize a Flow address: lowercase, ensure 0x prefix, zero-pad to 16 hex. */
export function normalizeFlowAddress(addr: string): string {
  let clean = addr.trim().toLowerCase();
  if (clean.startsWith("0x")) clean = clean.slice(2);
  if (!/^[0-9a-f]*$/.test(clean)) {
    throw new Error(`invalid Flow address (non-hex): ${addr}`);
  }
  if (clean.length > 16) {
    throw new Error(`invalid Flow address (too long): ${addr}`);
  }
  return "0x" + clean.padStart(16, "0");
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface FlowKeypair {
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 65-byte uncompressed public key (hex, no 0x, 0x04-prefixed). */
  readonly publicKeyHex: string;
  /**
   * Flow's account-key public-key form: the 64-byte body (X||Y), hex, no 0x —
   * this is exactly what `flow accounts add-contract` / FCL expect when
   * registering a secp256k1 key on-chain.
   */
  readonly flowPublicKeyHex: string;
  /** Deterministic mock account address — "0x" + 16 hex. */
  readonly address: string;
}

/** Build a keypair from a 32-byte secp256k1 private key. */
export function keypairFromPrivateKey(priv: Uint8Array): FlowKeypair {
  if (priv.length !== 32) {
    throw new Error(`Flow private key must be 32 bytes, got ${priv.length}`);
  }
  const pub = secp256k1.getPublicKey(priv, false); // uncompressed, 65 bytes (0x04||X||Y)
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub),
    flowPublicKeyHex: toHex(pub.slice(1)), // drop 0x04 → 64-byte X||Y (Flow form)
    address: pubkeyToMockAddress(pub),
  };
}

/**
 * Generate a fresh, cryptographically-random Flow keypair fully in-process.
 * The address is a deterministic mock derived from the pubkey ("0x"+16 hex);
 * the secp256k1 key itself is real and registerable on a live Flow account.
 */
export function generateFlowKeypair(): FlowKeypair {
  const priv = secp256k1.utils.randomPrivateKey(); // 32 bytes
  return keypairFromPrivateKey(priv);
}

/** Reconstruct a keypair from a private key hex string (with/without 0x). */
export function keypairFromHex(privateKeyHex: string): FlowKeypair {
  return keypairFromPrivateKey(hexToBytes(privateKeyHex));
}

// ============================================================================
//  RealFlowSigner
// ============================================================================

export interface RealFlowSignerConfig {
  /** Hex private key (with/without 0x). */
  readonly privateKeyHex?: string;
  /** Or supply a raw 32-byte private key directly. */
  readonly privateKey?: Uint8Array;
  /**
   * Or pin an explicit chain-assigned address (overrides the mock derivation).
   * Use this in production once the account has been created on-chain.
   */
  readonly address?: string;
  /**
   * Optional balance reader — wired to a Flow access-node script in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    tokenContract?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to @onflow/fcl `mutate`/`send` in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature without hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly tokenContract?: string;
    readonly reference?: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
  }) => Promise<{ readonly blockId?: string; readonly explorerUrl?: string }>;
  /** Network for explorer URLs. */
  readonly network?: "mainnet" | "testnet" | "emulator";
}

export class RealFlowSigner {
  /** Flow account address — "0x" + 16 hex. */
  readonly address: string;
  /** Full uncompressed public key hex (0x04-prefixed) — for providerMetadata. */
  readonly publicKeyHex: string;
  /** Flow account-key public-key form (64-byte X||Y hex). */
  readonly flowPublicKeyHex: string;
  private readonly priv: Uint8Array;
  private readonly cfg: RealFlowSignerConfig;
  private readonly network: "mainnet" | "testnet" | "emulator";

  constructor(cfg: RealFlowSignerConfig = {}) {
    let kp: FlowKeypair;
    if (cfg.privateKey) {
      kp = keypairFromPrivateKey(cfg.privateKey);
    } else if (cfg.privateKeyHex) {
      kp = keypairFromHex(cfg.privateKeyHex);
    } else {
      kp = generateFlowKeypair();
    }
    this.priv = hexToBytes(kp.privateKeyHex);
    this.address = cfg.address ? normalizeFlowAddress(cfg.address) : kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.flowPublicKeyHex = kp.flowPublicKeyHex;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Sign a deterministic message derived from the transfer intent. This is a
   * real secp256k1 ECDSA signature (RFC-6979 deterministic-k) over the
   * canonical Flow transfer descriptor, returned as compact 64-byte r||s hex —
   * exactly the form Flow expects for a transaction-payload signature. The
   * production `submit` hook assembles + broadcasts the actual Cadence tx.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    tokenContract?: string;
    reference?: string;
    memo?: string;
  }): Promise<{ signature: string; blockId?: string; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.tokenContract !== undefined
        ? { tokenContract: input.tokenContract }
        : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const signature = this.signDescriptor(descriptor);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.tokenContract !== undefined
          ? { tokenContract: input.tokenContract }
          : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.address,
      });
      return {
        signature,
        ...(res.blockId !== undefined ? { blockId: res.blockId } : {}),
        explorerUrl: res.explorerUrl ?? this.explorerUrl(res.blockId ?? signature),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return {
      signature,
      blockId: "",
      explorerUrl: this.explorerUrl(signature),
    };
  }

  /**
   * Produce a REAL secp256k1 signature over the canonical descriptor.
   * Returns compact 64-byte r||s hex (no recovery byte) — Flow's signature form.
   */
  signDescriptor(descriptor: string): string {
    const msgHash = sha256(new TextEncoder().encode(descriptor));
    const sig = secp256k1.sign(msgHash, this.priv);
    return toHex(sig.toCompactRawBytes()); // 64-byte r||s
  }

  async getBalance(tokenContract?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, tokenContract);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — used by tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const msgHash = sha256(new TextEncoder().encode(descriptor));
      const pub = hexToBytes(this.publicKeyHex);
      return secp256k1.verify(hexToBytes(signatureHex), msgHash, pub);
    } catch {
      return false;
    }
  }

  private explorerUrl(ref: string): string {
    const host =
      this.network === "mainnet"
        ? "https://www.flowscan.io"
        : this.network === "testnet"
          ? "https://testnet.flowscan.io"
          : "http://localhost:8080";
    return `${host}/tx/${ref}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Flow token transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  tokenContract?: string;
  reference?: string;
  memo?: string;
}): string {
  const parts = [
    `flow-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `token=${fields.tokenContract ?? "FlowToken"}`,
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
