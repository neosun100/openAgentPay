/**
 * RealInjectiveSigner — Ethermint secp256k1 signer backed by @noble/curves.
 * ============================================================================
 *
 * Injective is a Cosmos-SDK chain, but unlike the Cosmos Hub it uses
 * **Ethereum-style** account keys (Ethermint / EVMOS lineage). That changes
 * two things versus vanilla Cosmos:
 *
 *   1. BIP44 coin type is 60 (Ethereum), not 118 (ATOM):
 *        path = m/44'/60'/0'/0/0
 *   2. Address derivation is Ethereum/Ethermint-style, NOT ripemd160:
 *        eth20 = keccak256(uncompressed_pubkey[1:])[-20:]   (the EVM address)
 *        inj   = bech32("inj", eth20)
 *      i.e. the same 20-byte payload that yields the EIP-55 0x… address is
 *      bech32-encoded with the "inj" human-readable prefix.
 *
 * Everything else mirrors RealCosmosSigner: a real BIP39 mnemonic, a real
 * secp256k1 ECDSA signature over a canonical transfer descriptor, and a
 * pluggable `submit` hook so production can wire @injectivelabs/sdk-ts
 * broadcast without touching this file. Offline-safe by default.
 *
 * @license Apache-2.0
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// ============================================================================
//  Constants
// ============================================================================

/** Injective uses the Ethereum BIP44 coin type (Ethermint lineage). */
export const INJECTIVE_COIN_TYPE = 60;
/** Canonical Injective derivation path (m/44'/60'/0'/0/0). */
export const INJECTIVE_HD_PATH = "m/44'/60'/0'/0/0";
/** Injective bech32 human-readable prefix. */
export const INJECTIVE_BECH32_PREFIX = "inj";

// ============================================================================
//  Wallet / keypair helpers
// ============================================================================

export interface InjectiveWallet {
  /** 24-word BIP39 mnemonic (256-bit entropy). */
  readonly mnemonic: string;
  /** bech32 "inj1…" address. */
  readonly address: string;
}

export interface InjectiveKeypair {
  readonly mnemonic: string;
  /** 32-byte secp256k1 private key (hex, no 0x). */
  readonly privateKeyHex: string;
  /** 33-byte compressed secp256k1 public key (hex, no 0x). */
  readonly publicKeyHex: string;
  /** bech32 "inj1…" address. */
  readonly address: string;
  /** Ethereum-style 0x… address (EIP-55 checksummed) for the same key. */
  readonly ethAddress: string;
}

/**
 * Generate a fresh Injective wallet — a real 24-word mnemonic plus the
 * canonical "inj1…" address. Fully offline; no faucet/network involved.
 */
export function generateInjectiveWallet(): InjectiveWallet {
  const kp = generateInjectiveKeypair();
  return { mnemonic: kp.mnemonic, address: kp.address };
}

/** Full keypair generation — mnemonic + derived secp256k1 key + inj address. */
export function generateInjectiveKeypair(): InjectiveKeypair {
  // 256 bits of entropy → 24-word mnemonic.
  const mnemonic = generateMnemonic(wordlist, 256);
  return keypairFromMnemonic(mnemonic);
}

/**
 * Derive an Injective keypair from an existing BIP39 mnemonic. Validates the
 * mnemonic against the English wordlist + checksum before deriving.
 */
export function keypairFromMnemonic(mnemonic: string): InjectiveKeypair {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic (failed wordlist/checksum check)");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive(INJECTIVE_HD_PATH);
  if (!node.privateKey) {
    throw new Error(`Failed to derive private key at ${INJECTIVE_HD_PATH}`);
  }
  const privateKey = node.privateKey;
  const publicKey = secp256k1.getPublicKey(privateKey, true); // 33 bytes (compressed)
  const eth20 = ethAddressBytes(publicKey);
  return {
    mnemonic,
    privateKeyHex: toHex(privateKey),
    publicKeyHex: toHex(publicKey),
    address: bech32.encode(INJECTIVE_BECH32_PREFIX, bech32.toWords(eth20)),
    ethAddress: toEip55(eth20),
  };
}

/**
 * Ethermint address payload:
 *   keccak256(uncompressed_pubkey_without_0x04_prefix)[-20:]
 * This is identical to how an Ethereum address is computed from a pubkey.
 */
export function ethAddressBytes(publicKey: Uint8Array): Uint8Array {
  let uncompressed: Uint8Array;
  if (publicKey.length === 65) {
    uncompressed = publicKey;
  } else if (publicKey.length === 33) {
    // Decompress to 65-byte uncompressed form (0x04 || X || Y).
    uncompressed = secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(
      false
    );
  } else {
    throw new Error(
      `Injective pubkey must be 33 (compressed) or 65 (uncompressed) bytes, got ${publicKey.length}`
    );
  }
  // Drop the leading 0x04 tag, hash the 64-byte X||Y, take last 20 bytes.
  const hash = keccak_256(uncompressed.slice(1));
  return hash.slice(-20);
}

/**
 * Compute the canonical Injective bech32 address from a secp256k1 public key.
 *   address = bech32("inj", keccak256(uncompressed_pubkey[1:])[-20:])
 */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  const eth20 = ethAddressBytes(publicKey);
  return bech32.encode(INJECTIVE_BECH32_PREFIX, bech32.toWords(eth20));
}

/** EIP-55 checksummed 0x… address from the 20-byte payload. */
export function toEip55(eth20: Uint8Array): string {
  const hex = toHex(eth20); // lowercase, no 0x
  const hashHex = toHex(keccak_256(new TextEncoder().encode(hex)));
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    const c = hex[i] as string;
    const h = hashHex[i] as string;
    out += parseInt(h, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

// ============================================================================
//  RealInjectiveSigner
// ============================================================================

export interface RealInjectiveSignerConfig {
  /** Supply an existing 24-word mnemonic. */
  readonly mnemonic?: string;
  /** Chain id for explorer URLs / network labels (default "injective-1"). */
  readonly chainId?: string;
  /**
   * Optional balance reader — wired to an Injective LCD/REST endpoint in
   * production. If omitted, getBalance() returns 0 (offline-safe default).
   */
  readonly balanceReader?: (address: string, denom?: string) => Promise<bigint>;
  /**
   * Optional broadcast hook — wired to @injectivelabs/sdk-ts in production.
   * If omitted, signAndSubmit() returns the locally-computed signature without
   * hitting the network (offline-safe, deterministic).
   */
  readonly submit?: (input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly denom: string;
    readonly memo?: string;
    readonly signature: string;
    readonly signer: string;
    readonly pubkeyHex: string;
  }) => Promise<{ readonly txHash?: string; readonly height?: number }>;
}

export class RealInjectiveSigner {
  readonly address: string;
  readonly ethAddress: string;
  readonly publicKeyHex: string;
  readonly prefix: string = INJECTIVE_BECH32_PREFIX;
  readonly chainId: string;
  private readonly privateKey: Uint8Array;
  private readonly cfg: RealInjectiveSignerConfig;

  constructor(cfg: RealInjectiveSignerConfig = {}) {
    const kp = cfg.mnemonic
      ? keypairFromMnemonic(cfg.mnemonic)
      : generateInjectiveKeypair();
    this.privateKey = hexToBytes(kp.privateKeyHex);
    this.publicKeyHex = kp.publicKeyHex;
    this.address = kp.address;
    this.ethAddress = kp.ethAddress;
    this.chainId = cfg.chainId ?? "injective-1";
    this.cfg = cfg;
  }

  /**
   * Sign a deterministic descriptor derived from the transfer intent. Real
   * secp256k1 ECDSA over keccak256(descriptor) (Ethermint chains hash with
   * keccak, not sha256), returned as hex (compact 64-byte r||s). The
   * production `submit` hook assembles + broadcasts the actual MsgSend.
   */
  async signAndSubmit(input: {
    recipient: string;
    amountAtomic: string;
    denom: string;
    memo?: string;
  }): Promise<{
    signature: string;
    txHash?: string;
    height?: number;
    explorerUrl?: string;
  }> {
    const descriptor = canonicalTransferDescriptor({
      from: this.address,
      to: input.recipient,
      amountAtomic: input.amountAtomic,
      denom: input.denom,
      chainId: this.chainId,
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
    const msgHash = keccak_256(new TextEncoder().encode(descriptor));
    const sig = secp256k1.sign(msgHash, this.privateKey);
    const signature = toHex(sig.toCompactRawBytes()); // 64-byte r||s, hex

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        denom: input.denom,
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        signature,
        signer: this.address,
        pubkeyHex: this.publicKeyHex,
      });
      return {
        signature,
        ...(res.txHash !== undefined ? { txHash: res.txHash } : {}),
        ...(res.height !== undefined ? { height: res.height } : {}),
        ...(res.txHash !== undefined
          ? { explorerUrl: this.explorerUrl(res.txHash) }
          : {}),
      };
    }

    // Offline-safe path: signature is real, broadcast is deferred.
    return { signature };
  }

  async getBalance(denom = "inj"): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.address, denom);
    }
    return 0n;
  }

  /** Verify a signature this signer produced — useful for tests + audits. */
  verify(signatureHex: string, descriptor: string): boolean {
    try {
      const sig = hexToBytes(signatureHex);
      const msgHash = keccak_256(new TextEncoder().encode(descriptor));
      const pubkey = hexToBytes(this.publicKeyHex);
      return secp256k1.verify(sig, msgHash, pubkey);
    } catch {
      return false;
    }
  }

  private explorerUrl(txHash: string): string {
    return `https://explorer.injective.network/transaction/${txHash}`;
  }
}

// ============================================================================
//  Canonical transfer descriptor — the signed message
// ============================================================================

/**
 * Deterministic, canonical string representation of an Injective bank transfer.
 * Stable field ordering so the same intent always yields the same signature.
 */
export function canonicalTransferDescriptor(fields: {
  from: string;
  to: string;
  amountAtomic: string;
  denom: string;
  chainId: string;
  memo?: string;
}): string {
  const parts = [
    `injective-pay/v1`,
    `chain=${fields.chainId}`,
    `from=${fields.from}`,
    `to=${fields.to}`,
    `amount=${fields.amountAtomic}`,
    `denom=${fields.denom}`,
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
