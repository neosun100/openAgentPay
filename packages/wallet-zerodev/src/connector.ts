/**
 * ZeroDevConnector — WalletConnector for ZeroDev ERC-4337 smart accounts.
 * ============================================================================
 *
 * ZeroDev is the strongest on-chain spending-limit story in OpenAgentPay's
 * wallet matrix: the *sender* is a programmable smart contract account (the
 * Kernel account), so spending limits, session keys, and gas sponsorship are
 * enforced on-chain by the account itself — not by an off-chain policy layer.
 *
 * Identity model:
 *   - OWNER EOA      — secp256k1 key that authorizes UserOperations (never funds)
 *   - SMART ACCOUNT  — counterfactual CREATE2 address that holds USDC + is the
 *                      merchant-visible sender. `publicHandle` = smart account.
 *
 * Flow over the 5-method contract:
 *   - signAuthorization() → builds a UserOperation descriptor, signs the userOp
 *     hash with the owner key (real secp256k1). NO broadcast. Returns the owner
 *     signature + (mock) userOpHash in `extra`.
 *   - settle() → in production hands the signed UserOp to a ZeroDev bundler via
 *     the pluggable `submit` hook; offline returns a deterministic mock
 *     userOpHash (0x + 64) as the transactionRef.
 *
 * Asset: USDC on Base Sepolia (6 decimals).
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type ProtocolId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type TransactionRef,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";
import { type Address, type Hex } from "viem";

import { RealZeroDevSigner } from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "zerodev" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EVM stablecoin flows. */
export const ZERODEV_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

/** USDC on Base Sepolia (Circle's official testnet USDC). */
export const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

export const BASE_SEPOLIA_CHAIN_ID = 84532;

// ============================================================================
//  InstrumentStore
// ============================================================================

export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(instrumentId: InstrumentId): Promise<Instrument | undefined>;
}

export class MemoryInstrumentStore implements InstrumentStore {
  private readonly byUser = new Map<string, Instrument>();
  private readonly byId = new Map<string, Instrument>();
  async get(userId: UserId): Promise<Instrument | undefined> {
    return this.byUser.get(userId);
  }
  async put(instrument: Instrument): Promise<void> {
    this.byUser.set(instrument.userId, instrument);
    this.byId.set(instrument.id, instrument);
  }
  async getById(id: InstrumentId): Promise<Instrument | undefined> {
    return this.byId.get(id);
  }
}

// ============================================================================
//  Connector
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDC", decimals: 6, chain: "eip155:84532", contract: BASE_SEPOLIA_USDC },
];

export interface ZeroDevConnectorConfig {
  /** The owner-EOA-backed ERC-4337 signer. */
  readonly signer: RealZeroDevSigner;
  readonly instrumentStore: InstrumentStore;
  /** USDC token address override (default Base Sepolia USDC). */
  readonly tokenAddress?: Address;
  /** Whether gas is sponsored by a paymaster (default true — ZeroDev's headline feature). */
  readonly sponsoredGas?: boolean;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
}

export class ZeroDevConnector implements WalletConnector {
  private readonly signer: RealZeroDevSigner;
  private readonly store: InstrumentStore;
  private readonly tokenAddress: Address;
  private readonly sponsoredGas: boolean;
  private readonly now: () => number;

  constructor(cfg: ZeroDevConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.tokenAddress = cfg.tokenAddress ?? BASE_SEPOLIA_USDC;
    this.sponsoredGas = cfg.sponsoredGas ?? true;
    this.now = cfg.now ?? Date.now;
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "ZeroDev (ERC-4337 Smart Account)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [ZERODEV_PROTOCOL],
      requiresUserApproval: false, // owner key in Secrets Manager → no UI prompt
      settlesOnChain: true,
      typicalLatencyMs: 2500, // bundler inclusion on Base L2
      features: {
        smartAccount: true,
        erc4337: true,
        sponsoredGas: true,
        onChainSpendingLimits: true,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    // Idempotent: same userId → same instrument.
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const id = `payment-instrument-zerodev-${input.userId}` as InstrumentId;
    // publicHandle = the SMART ACCOUNT address (merchant-visible sender);
    // the owner EOA lives in providerMetadata.
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.smartAccountAddress,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        ownerAddress: this.signer.ownerAddress,
        smartAccountAddress: this.signer.smartAccountAddress,
        entryPoint: this.signer.entryPoint,
        chainId: this.signer.chainId,
        tokenAddress: this.tokenAddress,
        accountType: "erc4337-kernel",
        sponsoredGas: this.sponsoredGas,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance();
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDC", decimals: 6, chain: "eip155:84532", contract: this.tokenAddress },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign a UserOperation with the owner key. Produces a real secp256k1
   * signature over the userOp hash. Does NOT broadcast.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== ZERODEV_PROTOCOL) {
      throw new Error(
        `ZeroDevConnector only supports protocol ${ZERODEV_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (instrument.publicHandle !== this.signer.smartAccountAddress) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match smart account ${this.signer.smartAccountAddress}`
      );
    }

    const token =
      (input.request.asset.contract as Address | undefined) ?? this.tokenAddress;

    const result = await this.signer.signUserOp({
      to: input.request.recipient as Address,
      token,
      amountAtomic: input.request.amount.amountAtomic,
      nonce: input.request.nonce,
      sponsoredGas: this.sponsoredGas,
    });

    return {
      request: input.request,
      // signer = the SMART ACCOUNT (the on-chain authorizing entity / sender).
      signer: this.signer.smartAccountAddress,
      signature: result.signature,
      extra: {
        ownerAddress: this.signer.ownerAddress,
        smartAccountAddress: this.signer.smartAccountAddress,
        userOpHash: result.userOpHash,
        entryPoint: this.signer.entryPoint,
        chainId: this.signer.chainId,
        sponsoredGas: this.sponsoredGas,
        descriptor: result.descriptor,
        ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
      },
    };
  }

  /**
   * Submit the signed UserOperation. In production the `submit` hook on the
   * signer has already produced a real userOpHash + tx (surfaced via
   * signAuthorization's extra). Here we adapt that to a SettlementResult.
   * Offline: returns the deterministic mock userOpHash as transactionRef.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `base-sepolia`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing owner signature",
      };
    }
    const extra = (signed.extra ?? {}) as Record<string, unknown>;
    const userOpHash = extra["userOpHash"] as Hex | undefined;
    const txHash = extra["txHash"] as Hex | undefined;
    if (!userOpHash) {
      return {
        success: false,
        network: `base-sepolia`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing userOpHash in signed.extra",
      };
    }
    return {
      success: true,
      // userOpHash is the canonical ERC-4337 settlement reference.
      transactionRef: userOpHash as TransactionRef,
      network: `base-sepolia`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        userOpHash,
        ...(txHash !== undefined ? { txHash } : {}),
        entryPoint: extra["entryPoint"],
        smartAccount: extra["smartAccountAddress"],
        sponsoredGas: extra["sponsoredGas"],
      },
    };
  }

  // ---- Public helpers (useful for demos + tests) --------------------------

  get ownerAddress(): Address {
    return this.signer.ownerAddress;
  }

  get smartAccountAddress(): Address {
    return this.signer.smartAccountAddress;
  }

  // ---- Internals ---------------------------------------------------------

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) {
      throw new Error(`Instrument not found: ${id}`);
    }
    return i;
  }
}

// ============================================================================
//  Helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}
