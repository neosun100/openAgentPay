/**
 * RealZeroDevSigner — ERC-4337 smart-account signer backed by viem secp256k1.
 * ============================================================================
 *
 * ZeroDev is an account-abstraction (ERC-4337) wallet stack: the on-chain
 * actor is a *smart contract account* (the "Kernel" smart account), and an
 * **owner EOA** holds the secp256k1 key that authorizes UserOperations. The
 * smart account is what holds funds and what merchants see as the sender; the
 * owner EOA never holds funds — it only signs.
 *
 * What's REAL here (offline, zero network):
 *   - Owner EOA keypair: real secp256k1 (viem `generatePrivateKey`).
 *   - Smart-account address: deterministic **counterfactual** address derived
 *     from `keccak256(owner ++ salt)` truncated to 20 bytes. Documented as a
 *     mock CREATE2 counterfactual — a real ZeroDev deploy uses the Kernel
 *     factory's CREATE2 formula, but the *shape* (deterministic per owner+salt,
 *     valid 0x…40-hex EVM address) is identical and offline-derivable.
 *   - Signature: a real secp256k1 signature (EIP-191 personal_sign) by the
 *     owner over the canonical UserOperation hash. Verifiable with the owner's
 *     address — exactly the authorization a bundler/EntryPoint would check.
 *
 * What's pluggable (production wires a bundler):
 *   - `submit` hook → in production, send the UserOp to a ZeroDev bundler /
 *     EntryPoint and get the real userOpHash + on-chain tx. Offline default
 *     returns a deterministic mock userOpHash (0x + 64 hex) without network.
 *
 * @license Apache-2.0
 */

import { keccak256, toHex, encodeAbiParameters, type Address, type Hex } from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";

// ============================================================================
//  Owner keypair helpers
// ============================================================================

export interface ZeroDevOwnerKeypair {
  /** secp256k1 private key (Hex, 0x-prefixed) — the OWNER EOA key. NEVER funds. */
  readonly ownerPrivateKey: Hex;
  /** Owner EOA address (0x…40-hex) — signs UserOperations. */
  readonly ownerAddress: Address;
}

/** Generate a fresh, cryptographically-random owner EOA (secp256k1). */
export function generateZeroDevOwner(): ZeroDevOwnerKeypair {
  const ownerPrivateKey = generatePrivateKey();
  const account = privateKeyToAccount(ownerPrivateKey);
  return { ownerPrivateKey, ownerAddress: account.address };
}

/** Reconstruct an owner from an existing secp256k1 private key. */
export function ownerFromPrivateKey(ownerPrivateKey: Hex): ZeroDevOwnerKeypair {
  const account = privateKeyToAccount(ownerPrivateKey);
  return { ownerPrivateKey, ownerAddress: account.address };
}

/**
 * Derive the **counterfactual** smart-account address for an owner + salt.
 *
 * This mirrors the deterministic property of ERC-4337 CREATE2 deployment: the
 * same (owner, salt) always yields the same smart-account address, computable
 * before the account is ever deployed on-chain. We use
 * `keccak256(abi.encode(owner, saltBytes32))` and take the low 20 bytes — a
 * documented mock of the Kernel factory's real CREATE2 formula, sufficient for
 * offline determinism + a real EVM address shape.
 */
export function deriveSmartAccountAddress(owner: Address, saltHex: Hex): Address {
  const salt32 = padHex32(saltHex);
  const packed = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [owner, salt32]
  );
  const hash = keccak256(packed); // 0x + 64 hex
  // EVM address = last 20 bytes of the keccak hash.
  const addr = ("0x" + hash.slice(-40)) as Address;
  return addr;
}

// ============================================================================
//  Canonical UserOperation descriptor — the signed message
// ============================================================================

/**
 * The minimal, canonical UserOperation-style descriptor we sign. In real
 * ERC-4337 the EntryPoint computes `userOpHash = keccak256(packed-userOp,
 * entryPoint, chainId)`. We capture the same semantic fields in a stable,
 * deterministic ordering so the same intent always yields the same hash.
 */
export interface UserOpDescriptor {
  /** Smart-account sender (the counterfactual address). */
  readonly sender: Address;
  /** Recipient of the transfer (merchant). */
  readonly to: Address;
  /** USDC token contract (the call target asset). */
  readonly token: Address;
  /** Amount in atomic units (USDC 6dp). */
  readonly amountAtomic: string;
  /** Anti-replay nonce. */
  readonly nonce: string;
  /** EntryPoint address (canonical ERC-4337 v0.7 EntryPoint). */
  readonly entryPoint: Address;
  /** Chain id (Base Sepolia = 84532). */
  readonly chainId: number;
  /** Whether gas is sponsored by a paymaster. */
  readonly sponsoredGas: boolean;
}

/** Deterministic string form of the UserOp — stable field ordering. */
export function canonicalUserOpDescriptor(d: UserOpDescriptor): string {
  return [
    "erc4337-userop/v1",
    `sender=${d.sender}`,
    `to=${d.to}`,
    `token=${d.token}`,
    `amount=${d.amountAtomic}`,
    `nonce=${d.nonce}`,
    `entryPoint=${d.entryPoint}`,
    `chainId=${d.chainId}`,
    `sponsoredGas=${d.sponsoredGas ? "1" : "0"}`,
  ].join("\n");
}

/** keccak256 over the canonical descriptor — the userOpHash analogue. */
export function userOpHash(d: UserOpDescriptor): Hex {
  return keccak256(toHex(canonicalUserOpDescriptor(d)));
}

// ============================================================================
//  RealZeroDevSigner
// ============================================================================

/** Canonical ERC-4337 v0.7 EntryPoint (Base Sepolia, same as mainnet). */
export const ENTRYPOINT_V07 =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;

export interface RealZeroDevSignerConfig {
  /** Existing owner secp256k1 private key. If omitted, a fresh one is generated. */
  readonly ownerPrivateKey?: Hex;
  /** Salt that selects which counterfactual smart account this owner controls. */
  readonly salt?: Hex;
  /** EntryPoint override (defaults to canonical v0.7). */
  readonly entryPoint?: Address;
  /** Chain id (default Base Sepolia 84532). */
  readonly chainId?: number;
  /**
   * Optional balance reader — wired to a Base Sepolia RPC (USDC balanceOf) in
   * production. Offline default returns 0n.
   */
  readonly balanceReader?: (smartAccount: Address) => Promise<bigint>;
  /**
   * Optional bundler-submit hook — in production sends the signed UserOp to a
   * ZeroDev bundler / EntryPoint and returns the real userOpHash + tx hash.
   * Offline default returns a deterministic mock userOpHash (0x + 64 hex).
   */
  readonly submit?: (input: {
    readonly descriptor: UserOpDescriptor;
    readonly signature: Hex;
    readonly owner: Address;
  }) => Promise<{ readonly userOpHash: Hex; readonly txHash?: Hex }>;
}

export class RealZeroDevSigner {
  /** Owner EOA — the secp256k1 signer of UserOperations. */
  readonly ownerAddress: Address;
  /** Counterfactual smart-account address — the on-chain sender / publicHandle. */
  readonly smartAccountAddress: Address;
  readonly entryPoint: Address;
  readonly chainId: number;

  private readonly account: PrivateKeyAccount;
  private readonly salt: Hex;
  private readonly cfg: RealZeroDevSignerConfig;

  constructor(cfg: RealZeroDevSignerConfig = {}) {
    const ownerKey = cfg.ownerPrivateKey ?? generatePrivateKey();
    this.account = privateKeyToAccount(ownerKey);
    this.ownerAddress = this.account.address;
    this.salt = cfg.salt ?? ("0x" + "00".repeat(32)) as Hex;
    this.entryPoint = cfg.entryPoint ?? ENTRYPOINT_V07;
    this.chainId = cfg.chainId ?? 84532;
    this.smartAccountAddress = deriveSmartAccountAddress(
      this.ownerAddress,
      this.salt
    );
    this.cfg = cfg;
  }

  /**
   * Sign a UserOperation with the owner key (real secp256k1 / EIP-191). Returns
   * the owner signature + the userOpHash (mock or bundler-provided). Does NOT
   * broadcast unless a `submit` hook is configured.
   */
  async signUserOp(input: {
    to: Address;
    token: Address;
    amountAtomic: string;
    nonce: string;
    sponsoredGas: boolean;
  }): Promise<{
    signature: Hex;
    userOpHash: Hex;
    descriptor: UserOpDescriptor;
    txHash?: Hex;
  }> {
    const descriptor: UserOpDescriptor = {
      sender: this.smartAccountAddress,
      to: input.to,
      token: input.token,
      amountAtomic: input.amountAtomic,
      nonce: input.nonce,
      entryPoint: this.entryPoint,
      chainId: this.chainId,
      sponsoredGas: input.sponsoredGas,
    };
    const hash = userOpHash(descriptor);
    // Real secp256k1 signature by the owner over the userOpHash (EIP-191).
    const signature = await this.account.signMessage({
      message: { raw: hash },
    });

    if (this.cfg.submit) {
      const res = await this.cfg.submit({
        descriptor,
        signature,
        owner: this.ownerAddress,
      });
      return {
        signature,
        userOpHash: res.userOpHash,
        descriptor,
        ...(res.txHash !== undefined ? { txHash: res.txHash } : {}),
      };
    }

    // Offline-safe path: signature is real; userOpHash is a deterministic mock
    // derived from the canonical descriptor (0x + 64 hex), shaped like a real
    // ERC-4337 userOpHash. A bundler `submit` hook overrides this.
    return { signature, userOpHash: hash, descriptor };
  }

  async getBalance(): Promise<bigint> {
    if (this.cfg.balanceReader) {
      return this.cfg.balanceReader(this.smartAccountAddress);
    }
    return 0n;
  }

  /** Verify an owner signature over a UserOp descriptor — for tests + audits. */
  async verify(signature: Hex, descriptor: UserOpDescriptor): Promise<boolean> {
    try {
      const { verifyMessage } = await import("viem");
      const hash = userOpHash(descriptor);
      return await verifyMessage({
        address: this.ownerAddress,
        message: { raw: hash },
        signature,
      });
    } catch {
      return false;
    }
  }
}

// ============================================================================
//  Hex helpers
// ============================================================================

/** Pad/truncate a hex string to a bytes32 (0x + 64 hex). */
function padHex32(h: Hex): Hex {
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  if (clean.length >= 64) return ("0x" + clean.slice(0, 64)) as Hex;
  return ("0x" + clean.padStart(64, "0")) as Hex;
}
