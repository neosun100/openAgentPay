/**
 * RealMoneroSigner — Monero view-key identity + Ed25519 auth signer.
 * ============================================================================
 *
 * Monero's real on-chain privacy is delivered by RingCT + ring signatures +
 * stealth addresses + bulletproofs — all OUT OF SCOPE here. This connector
 * implements the **identity + authorization layer** only:
 *
 *   - A Monero account is TWO Ed25519 keypairs: a SPEND key and a VIEW key.
 *       * spend key  → authorizes outflows (the secret we sign with)
 *       * view key   → lets a third party *see* incoming funds without
 *                      being able to spend them (shared in providerMetadata)
 *   - The public address packs both public keys plus a network byte and a
 *     checksum, then base58-encodes the whole thing.
 *
 * Address layout (the bytes we encode):
 *
 *     [ networkByte (1) ][ spendPub (32) ][ viewPub (32) ][ checksum (4) ]
 *       └ 0x35 testnet/                                     └ keccak256(
 *         this build defaults to testnet                       prefix||spend||view
 *                                                            )[:4]
 *
 * ── base58 caveat (documented, intentional) ────────────────────────────────
 * Real Monero uses a CUSTOM *block-based* base58 (8-byte blocks → 11 chars,
 * remainder padded) — NOT the bitcoin-style streaming base58 that @scure/base
 * implements. Reproducing Monero's exact codec requires its bespoke block
 * encoder. For OpenAgentPay's identity+auth layer we use a **documented
 * simplified base58check**: standard streaming base58 (@scure/base) over the
 * `prefix||spend||view||checksum` buffer. The result is a deterministic,
 * round-trippable, checksummed Monero-shaped address — it is NOT byte-for-byte
 * interchangeable with monero-wallet-cli output. `decodeMoneroAddress()` is the
 * exact inverse of `encodeMoneroAddress()`, which is what our verify() relies
 * on. Swap in a block-based base58 here to get wallet-cli-identical strings.
 *
 * Why not monero-ts / monero-javascript?
 *   - Conformance + unit tests must run offline with zero heavyweight deps
 *     (those ship a full wasm wallet + daemon RPC).
 *   - The cryptographic identity (keypairs → address → signature) is fully
 *     real here; only daemon *broadcast* needs a live node, kept pluggable via
 *     the optional `submit` hook.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3";

import type { MoneroSigner } from "./connector.js";

// ============================================================================
//  Network prefix bytes
// ============================================================================

/**
 * Single-byte network tag prepended to the address payload. Real Monero uses
 * multi-byte varint prefixes (mainnet 18, testnet 53, stagenet 24); we use the
 * low byte so the address still visually disambiguates networks.
 *   - mainnet  : 0x12 (18)
 *   - testnet  : 0x35 (53)   ← default for this connector (testnet-only policy)
 *   - stagenet : 0x18 (24)
 */
export const MONERO_NETWORK_BYTE = {
  mainnet: 0x12,
  testnet: 0x35,
  stagenet: 0x18,
} as const;

export type MoneroNetwork = keyof typeof MONERO_NETWORK_BYTE;

// ============================================================================
//  Address codec — encode / decode (exact inverses)
// ============================================================================

const CHECKSUM_LEN = 4;

/** keccak256(data)[:4] — Monero uses keccak (not SHA3-NIST) for its checksum. */
function checksum4(data: Uint8Array): Uint8Array {
  return keccak_256(data).slice(0, CHECKSUM_LEN);
}

/**
 * Pack a Monero account (spend + view public keys) into a checksummed,
 * base58-encoded address string. See file header for the base58 caveat.
 */
export function encodeMoneroAddress(
  spendPub: Uint8Array,
  viewPub: Uint8Array,
  network: MoneroNetwork = "testnet"
): string {
  if (spendPub.length !== 32) {
    throw new Error(`Monero spend pubkey must be 32 bytes, got ${spendPub.length}`);
  }
  if (viewPub.length !== 32) {
    throw new Error(`Monero view pubkey must be 32 bytes, got ${viewPub.length}`);
  }
  const prefix = MONERO_NETWORK_BYTE[network];
  const data = new Uint8Array(1 + 32 + 32);
  data[0] = prefix;
  data.set(spendPub, 1);
  data.set(viewPub, 33);
  const cs = checksum4(data);
  const full = new Uint8Array(data.length + CHECKSUM_LEN);
  full.set(data, 0);
  full.set(cs, data.length);
  return base58.encode(full);
}

export interface DecodedMoneroAddress {
  readonly network: MoneroNetwork;
  readonly networkByte: number;
  readonly spendPub: Uint8Array;
  readonly viewPub: Uint8Array;
}

/**
 * Decode + checksum-verify a Monero address → its two public keys + network.
 * Exact inverse of `encodeMoneroAddress`. Throws on bad base58, wrong length,
 * unknown network byte, or checksum mismatch.
 */
export function decodeMoneroAddress(address: string): DecodedMoneroAddress {
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("Monero address must be a non-empty string");
  }
  let full: Uint8Array;
  try {
    full = base58.decode(address);
  } catch (e) {
    throw new Error(`Monero address is not valid base58: ${(e as Error).message}`);
  }
  const expectedLen = 1 + 32 + 32 + CHECKSUM_LEN;
  if (full.length !== expectedLen) {
    throw new Error(
      `Monero address must decode to ${expectedLen} bytes, got ${full.length}`
    );
  }
  const data = full.slice(0, full.length - CHECKSUM_LEN);
  const cs = full.slice(full.length - CHECKSUM_LEN);
  const expected = checksum4(data);
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    if (cs[i] !== expected[i]) {
      throw new Error("Monero address checksum mismatch");
    }
  }
  const networkByte = data[0]!;
  const network = networkFromByte(networkByte);
  return {
    network,
    networkByte,
    spendPub: data.slice(1, 33),
    viewPub: data.slice(33, 65),
  };
}

function networkFromByte(b: number): MoneroNetwork {
  for (const [name, byte] of Object.entries(MONERO_NETWORK_BYTE)) {
    if (byte === b) return name as MoneroNetwork;
  }
  throw new Error(`Unknown Monero network byte: 0x${b.toString(16)}`);
}

/** True iff `s` decodes + checksums as a valid Monero address. */
export function isValidMoneroAddress(s: string): boolean {
  try {
    decodeMoneroAddress(s);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface MoneroKeypair {
  /** 32-byte Ed25519 spend secret (hex, no 0x) — authorizes outflows. */
  readonly spendSecretHex: string;
  /** 32-byte Ed25519 view secret (hex, no 0x) — read-only incoming visibility. */
  readonly viewSecretHex: string;
  /** 32-byte spend public key (hex). */
  readonly spendPubHex: string;
  /** 32-byte view public key (hex). */
  readonly viewPubHex: string;
  /** base58 standard address packing both public keys. */
  readonly address: string;
  /** Network this address belongs to. */
  readonly network: MoneroNetwork;
}

/**
 * Generate a fresh, cryptographically-random Monero account: an independent
 * spend keypair and view keypair (two Ed25519 keys). In a real Monero wallet
 * the view secret is derived as keccak256(spendSecret) reduced mod l; here we
 * generate it independently so the spend secret is never recoverable from the
 * (shareable) view secret — a strictly stronger separation for our identity
 * layer. The address is identical in shape either way.
 */
export function generateMoneroKeypair(
  network: MoneroNetwork = "testnet"
): MoneroKeypair {
  const spendSecret = ed25519.utils.randomPrivateKey(); // 32 bytes
  const viewSecret = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSecrets(spendSecret, viewSecret, network);
}

/** Build a keypair from raw 32-byte spend + view secrets. */
export function keypairFromSecrets(
  spendSecret: Uint8Array,
  viewSecret: Uint8Array,
  network: MoneroNetwork = "testnet"
): MoneroKeypair {
  if (spendSecret.length !== 32) {
    throw new Error(`Monero spend secret must be 32 bytes, got ${spendSecret.length}`);
  }
  if (viewSecret.length !== 32) {
    throw new Error(`Monero view secret must be 32 bytes, got ${viewSecret.length}`);
  }
  const spendPub = ed25519.getPublicKey(spendSecret);
  const viewPub = ed25519.getPublicKey(viewSecret);
  return {
    spendSecretHex: toHex(spendSecret),
    viewSecretHex: toHex(viewSecret),
    spendPubHex: toHex(spendPub),
    viewPubHex: toHex(viewPub),
    address: encodeMoneroAddress(spendPub, viewPub, network),
    network,
  };
}

/** Load a keypair from hex spend + view secrets. */
export function keypairFromHex(
  spendSecretHex: string,
  viewSecretHex: string,
  network: MoneroNetwork = "testnet"
): MoneroKeypair {
  return keypairFromSecrets(
    hexToBytes(spendSecretHex),
    hexToBytes(viewSecretHex),
    network
  );
}

// ============================================================================
//  RealMoneroSigner
// ============================================================================

export interface RealMoneroSignerConfig {
  /** Raw 32-byte spend secret. */
  readonly spendSecret?: Uint8Array;
  /** Raw 32-byte view secret. */
  readonly viewSecret?: Uint8Array;
  /** Hex spend secret (alternative to spendSecret). */
  readonly spendSecretHex?: string;
  /** Hex view secret (alternative to viewSecret). */
  readonly viewSecretHex?: string;
  /** Network (default testnet — testnet-only policy until GA). */
  readonly network?: MoneroNetwork;
  /**
   * Optional balance reader — wired to a Monero daemon / wallet-rpc
   * `get_balance` in production. If omitted, getBalance() returns 0
   * (offline-safe default).
   */
  readonly balanceReader?: (address: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to wallet-rpc `transfer` /
   * daemon `send_raw_transaction` in production. If omitted, signAndSubmit()
   * returns the locally-computed signature without hitting the network
   * (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly paymentId?: string;
    readonly memo?: string;
    readonly signatureHex: string;
    readonly signer: string;
  }) => Promise<{ readonly txHash?: string; readonly explorerUrl?: string }>;
}

export class RealMoneroSigner implements MoneroSigner {
  readonly address: string;
  /** Public view key (hex) — safe to share; lets watchers see incoming funds. */
  readonly viewPubHex: string;
  /** Secret view key (hex) — shareable read-only key (NOT the spend key). */
  readonly viewSecretHex: string;
  readonly network: MoneroNetwork;
  private readonly spendSecret: Uint8Array;
  private readonly cfg: RealMoneroSignerConfig;

  constructor(cfg: RealMoneroSignerConfig = {}) {
    const network = cfg.network ?? "testnet";
    let kp: MoneroKeypair;
    if (cfg.spendSecret && cfg.viewSecret) {
      kp = keypairFromSecrets(cfg.spendSecret, cfg.viewSecret, network);
    } else if (cfg.spendSecretHex && cfg.viewSecretHex) {
      kp = keypairFromHex(cfg.spendSecretHex, cfg.viewSecretHex, network);
    } else {
      kp = generateMoneroKeypair(network);
    }
    this.spendSecret = hexToBytes(kp.spendSecretHex);
    this.address = kp.address;
    this.viewPubHex = kp.viewPubHex;
    this.viewSecretHex = kp.viewSecretHex;
    this.network = kp.network;
    this.cfg = cfg;
  }

  /**
   * Sign a deterministic message derived from the transfer intent, using the
   * SPEND key (the secret that authorizes outflows). Real Ed25519 signature
   * over the canonical descriptor (network-separated for replay safety).
   *
   * The production `submit` hook assembles + broadcasts the actual RingCT
   * transaction; the signature here is the agent's cryptographic authorization,
   * returned hex.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    paymentId?: string;
    memo?: string;
  }): Promise<{ signatureHex: string; txHash?: string; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      network: this.network,
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.paymentId !== undefined ? { paymentId: input.paymentId } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msg = keccak_256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.spendSecret);
    const signatureHex = toHex(sigBytes);

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.paymentId !== undefined ? { paymentId: input.paymentId } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signatureHex,
        signer: this.address,
      });
      return {
        signatureHex,
        ...(res.txHash !== undefined ? { txHash: res.txHash } : {}),
        explorerUrl: res.explorerUrl ?? this.explorerUrl(res.txHash ?? signatureHex),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred. We surface
    // the signature itself as the local reference (no real tx hash yet).
    return {
      signatureHex,
      explorerUrl: this.explorerUrl(signatureHex),
    };
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address);
    }
    return 0n;
  }

  /** The spend public key (hex) — derived for audits / verification. */
  get spendPubHex(): string {
    return toHex(ed25519.getPublicKey(this.spendSecret));
  }

  /**
   * Verify a signature this signer produced over `descriptor`, using the
   * SPEND public key embedded in the address. Useful for tests + audits.
   */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msg = keccak_256(new TextEncoder().encode(descriptor));
      const { spendPub } = decodeMoneroAddress(this.address);
      return ed25519.verify(sig, msg, spendPub);
    } catch {
      return false;
    }
  }

  private explorerUrl(ref: string): string {
    // xmrchain has per-network explorers; testnet has community explorers.
    const host =
      this.network === "mainnet"
        ? "https://xmrchain.net/tx"
        : this.network === "stagenet"
        ? "https://stagenet.xmrchain.net/tx"
        : "https://testnet.xmrchain.net/tx";
    return `${host}/${ref}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a Monero transfer intent.
 * Stable field ordering so the same intent always yields the same signature.
 * Includes the network so a testnet signature can't be replayed on mainnet.
 */
export function canonicalTransferDescriptor(fields: {
  network: MoneroNetwork;
  from: string;
  to: string;
  amountAtomic: string;
  paymentId?: string;
  memo?: string;
}): string {
  const parts = [
    `monero-pay/v1`,
    `network=${fields.network}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `paymentId=${fields.paymentId ?? ""}`,
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
