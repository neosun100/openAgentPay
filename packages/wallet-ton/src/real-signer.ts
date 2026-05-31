/**
 * RealTonSigner — Ed25519 signer for TON (The Open Network).
 * ============================================================================
 *
 * Like the Solana/Stellar connectors, this is a PURE-TypeScript signer backed
 * by @noble/curves — no @ton/ton or tonweb dependency. The cryptographic
 * identity (keypair → address → signature) is fully real and verifiable; only
 * the on-chain broadcast needs a live TON node, kept pluggable via an optional
 * `submit` hook (offline-safe, deterministic by default).
 *
 * TON address model
 * -----------------
 * A TON "raw" address is `<workchain>:<account_id>` where account_id is a
 * 256-bit hash. In a real wallet, account_id = sha256(StateInit cell) — the
 * hash of the wallet's initial code+data BoC. We do NOT assemble a real
 * StateInit cell here (that needs the full TVM cell/BoC machinery); instead we
 * use account_id = sha256(pubkey) as a documented stand-in. The *encoding*
 * (tag/workchain/crc16/base64url) is byte-for-byte the real user-friendly
 * format, so produced addresses are 48-char base64url exactly like Tonkeeper
 * displays.
 *
 * User-friendly address layout (36 bytes → base64url, 48 chars):
 *   [0]      tag       0x11 (bounceable) | 0x51 (non-bounceable); +0x80 for testnet
 *   [1]      workchain 0x00 (basechain) | 0xff (masterchain, as signed -1)
 *   [2..34)  account_id  32 bytes
 *   [34..36) crc16-ccitt over the preceding 34 bytes (big-endian)
 *
 * Signature: real Ed25519 over sha256(canonical transfer descriptor), returned
 * as lowercase hex (64 bytes → 128 hex chars) — TON signatures are 64 raw bytes.
 *
 * @license Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base64urlnopad } from "@scure/base";

import type { TonSigner } from "./connector.js";

// ============================================================================
//  Address tag / workchain constants
// ============================================================================

const TAG_BOUNCEABLE = 0x11;
const TAG_NON_BOUNCEABLE = 0x51;
const TAG_TEST_ONLY = 0x80; // OR'd into the tag for testnet-only addresses
const WORKCHAIN_BASECHAIN = 0x00;
const WORKCHAIN_MASTERCHAIN = 0xff; // -1 as an unsigned byte

export interface TonAddressOptions {
  /** Bounceable flag (default true — the EQ… form). Non-bounceable is UQ…. */
  readonly bounceable?: boolean;
  /** Mark as testnet-only address (tag | 0x80). Default true (we're testnet-first). */
  readonly testOnly?: boolean;
  /** Workchain: 0 = basechain (default), -1 = masterchain. */
  readonly workchain?: 0 | -1;
}

// ============================================================================
//  Keypair helpers
// ============================================================================

export interface TonKeypair {
  /** 32-byte Ed25519 seed (hex, no 0x). TON's "secret key" seed. */
  readonly secretSeedHex: string;
  /** 32-byte public key, hex (no 0x). */
  readonly publicKeyHex: string;
  /** 32-byte account_id, hex — sha256(pubkey) stand-in for StateInit hash. */
  readonly accountIdHex: string;
  /** User-friendly base64url address, 48 chars (bounceable, testnet by default). */
  readonly address: string;
  /** Raw `workchain:account_id_hex` form (e.g., "0:abcd…"). */
  readonly rawAddress: string;
}

/**
 * Generate a fresh, cryptographically-random TON keypair.
 * The address is a real 48-char base64url user-friendly TON address.
 */
export function generateTonKeypair(opts: TonAddressOptions = {}): TonKeypair {
  const seed = ed25519.utils.randomPrivateKey(); // 32 bytes
  return keypairFromSeed(seed, opts);
}

/** Reconstruct a keypair from a 32-byte Ed25519 seed. */
export function keypairFromSeed(
  seed: Uint8Array,
  opts: TonAddressOptions = {}
): TonKeypair {
  if (seed.length !== 32) {
    throw new Error(`TON seed must be 32 bytes, got ${seed.length}`);
  }
  const pubkey = ed25519.getPublicKey(seed);
  // account_id = sha256(pubkey) — documented stand-in for the real StateInit
  // cell hash. The encoding below is the real user-friendly format.
  const accountId = sha256(pubkey);
  const workchain = opts.workchain ?? 0;
  const address = encodeTonAddress(accountId, {
    bounceable: opts.bounceable ?? true,
    testOnly: opts.testOnly ?? true,
    workchain,
  });
  return {
    secretSeedHex: toHex(seed),
    publicKeyHex: toHex(pubkey),
    accountIdHex: toHex(accountId),
    address,
    rawAddress: `${workchain}:${toHex(accountId)}`,
  };
}

/** Load a keypair from a hex-encoded 32-byte seed (with or without 0x). */
export function keypairFromHex(
  seedHex: string,
  opts: TonAddressOptions = {}
): TonKeypair {
  const bytes = hexToBytes(seedHex);
  if (bytes.length !== 32) {
    throw new Error(`TON seed hex must decode to 32 bytes, got ${bytes.length}`);
  }
  return keypairFromSeed(bytes, opts);
}

// ============================================================================
//  Address encoding / decoding (the real user-friendly format)
// ============================================================================

/**
 * Encode a 32-byte account_id into a 48-char base64url user-friendly address.
 * Layout: tag(1) || workchain(1) || account_id(32) || crc16-ccitt(2) → base64url.
 */
export function encodeTonAddress(
  accountId: Uint8Array,
  opts: TonAddressOptions = {}
): string {
  if (accountId.length !== 32) {
    throw new Error(`account_id must be 32 bytes, got ${accountId.length}`);
  }
  let tag = opts.bounceable === false ? TAG_NON_BOUNCEABLE : TAG_BOUNCEABLE;
  if (opts.testOnly ?? true) tag |= TAG_TEST_ONLY;
  const workchainByte =
    (opts.workchain ?? 0) === -1 ? WORKCHAIN_MASTERCHAIN : WORKCHAIN_BASECHAIN;

  const payload = new Uint8Array(34);
  payload[0] = tag & 0xff;
  payload[1] = workchainByte;
  payload.set(accountId, 2);

  const crc = crc16Ccitt(payload);
  const full = new Uint8Array(36);
  full.set(payload, 0);
  full[34] = (crc >> 8) & 0xff;
  full[35] = crc & 0xff;

  // base64url without padding → 36 bytes = 48 chars exactly.
  return base64urlnopad.encode(full);
}

export interface DecodedTonAddress {
  readonly tag: number;
  readonly bounceable: boolean;
  readonly testOnly: boolean;
  readonly workchain: 0 | -1;
  readonly accountIdHex: string;
}

/**
 * Decode + validate a user-friendly TON address. Throws on bad length or CRC.
 */
export function decodeTonAddress(address: string): DecodedTonAddress {
  const full = base64urlnopad.decode(address);
  if (full.length !== 36) {
    throw new Error(`TON address must decode to 36 bytes, got ${full.length}`);
  }
  const payload = full.slice(0, 34);
  const wantCrc = (full[34]! << 8) | full[35]!;
  const gotCrc = crc16Ccitt(payload);
  if (wantCrc !== gotCrc) {
    throw new Error(
      `TON address CRC mismatch: expected ${gotCrc}, got ${wantCrc}`
    );
  }
  const tag = payload[0]!;
  const testOnly = (tag & TAG_TEST_ONLY) !== 0;
  const baseTag = tag & ~TAG_TEST_ONLY;
  const bounceable = baseTag === TAG_BOUNCEABLE;
  const workchain: 0 | -1 = payload[1] === WORKCHAIN_MASTERCHAIN ? -1 : 0;
  return {
    tag,
    bounceable,
    testOnly,
    workchain,
    accountIdHex: toHex(payload.slice(2, 34)),
  };
}

/** True if the string is a structurally valid 48-char base64url TON address. */
export function isValidTonAddress(address: string): boolean {
  try {
    if (address.length !== 48) return false;
    decodeTonAddress(address);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
//  RealTonSigner
// ============================================================================

export interface RealTonSignerConfig {
  /** Supply a raw 32-byte seed directly. */
  readonly seed?: Uint8Array;
  /** Or a hex-encoded 32-byte seed (with or without 0x). */
  readonly seedHex?: string;
  /** Address options (bounceable / testOnly / workchain). */
  readonly addressOptions?: TonAddressOptions;
  /**
   * Optional balance reader — wired to a toncenter/TON HTTP API in production.
   * If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (
    address: string,
    jettonMaster?: string
  ) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to `@ton/ton` Client.sendExternalMessage in
   * production. If omitted, signAndSubmit() returns the locally-computed
   * signature + a deterministic mock tx ref without hitting the network.
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly jettonMaster?: string;
    readonly comment?: string;
    readonly seqno?: number;
    readonly signature: string;
    readonly signer: string;
  }) => Promise<{ readonly txHash?: string; readonly explorerUrl?: string }>;
  /** Network label for explorer URLs / settlement metadata. */
  readonly network?: "mainnet" | "testnet";
}

export class RealTonSigner implements TonSigner {
  readonly address: string;
  readonly publicKeyHex: string;
  private readonly seed: Uint8Array;
  private readonly cfg: RealTonSignerConfig;
  private readonly network: "mainnet" | "testnet";

  constructor(cfg: RealTonSignerConfig = {}) {
    let kp: TonKeypair;
    const addrOpts = cfg.addressOptions ?? {};
    if (cfg.seed) {
      kp = keypairFromSeed(cfg.seed, addrOpts);
    } else if (cfg.seedHex) {
      kp = keypairFromHex(cfg.seedHex, addrOpts);
    } else {
      kp = generateTonKeypair(addrOpts);
    }
    this.seed = hexToBytes(kp.secretSeedHex);
    this.address = kp.address;
    this.publicKeyHex = kp.publicKeyHex;
    this.cfg = cfg;
    this.network = cfg.network ?? "testnet";
  }

  /**
   * Produce a REAL Ed25519 signature over the canonical transfer descriptor.
   * In a live TON wallet this signature authorizes the wallet's external
   * message body; here it's the agent's cryptographic authorization. The
   * pluggable `submit` hook assembles + broadcasts the real BoC.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    jettonMaster?: string;
    comment?: string;
    seqno?: number;
  }): Promise<{ signature: string; txHash?: string; explorerUrl?: string }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      ...(input.jettonMaster !== undefined
        ? { jettonMaster: input.jettonMaster }
        : {}),
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      ...(input.seqno !== undefined ? { seqno: input.seqno } : {}),
    });
    const msg = sha256(new TextEncoder().encode(descriptor));
    const sigBytes = ed25519.sign(msg, this.seed);
    const signature = toHex(sigBytes); // 64 bytes → 128 hex chars (TON sig form)

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...(input.jettonMaster !== undefined
          ? { jettonMaster: input.jettonMaster }
          : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(input.seqno !== undefined ? { seqno: input.seqno } : {}),
        signature,
        signer: this.address,
      });
      const txHash = res.txHash ?? signature;
      return {
        signature,
        txHash,
        explorerUrl: res.explorerUrl ?? this.explorerUrl(txHash),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred. Derive a
    // deterministic mock tx ref from the signature so settle() is reproducible.
    const mockTx = toHex(sha256(sigBytes)).slice(0, 64);
    return {
      signature,
      txHash: mockTx,
      explorerUrl: this.explorerUrl(mockTx),
    };
  }

  async getBalance(jettonMaster?: string): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, jettonMaster);
    }
    return 0n;
  }

  /**
   * Verify a hex signature this signer produced over a descriptor — used in
   * tests + audits. Tampering with the descriptor MUST flip this to false.
   */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msg = sha256(new TextEncoder().encode(descriptor));
      const pubkey = hexToBytes(this.publicKeyHex);
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(tx: string): string {
    const host =
      this.network === "testnet" ? "testnet.tonviewer.com" : "tonviewer.com";
    return `https://${host}/transaction/${tx}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of a TON transfer intent.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  jettonMaster?: string;
  comment?: string;
  seqno?: number;
}): string {
  const parts = [
    `ton-pay/v1`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `jetton=${fields.jettonMaster ?? "native"}`,
    `comment=${fields.comment ?? ""}`,
    `seqno=${fields.seqno ?? 0}`,
  ];
  return parts.join("\n");
}

// ============================================================================
//  CRC16-CCITT (XModem) — TON address checksum
// ============================================================================

/** CRC16-CCITT/XMODEM, poly 0x1021, init 0x0000 — TON's address checksum. */
export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
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
