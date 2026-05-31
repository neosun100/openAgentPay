/**
 * MagicConnector — implements WalletConnector for Magic.link email wallets.
 * ============================================================================
 *
 * Magic.link (https://magic.link) is a mainstream, email-based non-custodial
 * wallet provider. Users authenticate with an email magic-link; Magic
 * provisions an EVM key in a secure enclave keyed to that email. From
 * OpenAgentPay's perspective Magic is "an EVM account that signs EIP-712" —
 * so this connector reuses the same x402 / EIP-3009 flow as wallet-hashkey,
 * but keys the wallet identity to an *email* rather than a raw private key.
 *
 *   - Identity        : config.agentEmail  (stored in providerMetadata.email)
 *   - publicHandle    : 0x checksummed address derived from the secp256k1 key
 *   - Asset           : USDC on Base Sepolia (6 decimals)
 *   - signAuthorization: EIP-712 EIP-3009 transferWithAuthorization (real sig)
 *   - settle          : pluggable broadcast hook (offline-safe default)
 *
 * Capability flags: emailBased=true, requiresUserApproval=false (the agent
 * holds a delegated session key; no interactive magic-link per payment).
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type Money,
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

import {
  type Eip3009Authorization,
  type Eip712Domain,
  type MagicSignedAuthorization,
  RealMagicSigner,
  generateNonce,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "magic" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const MAGIC_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

/** Base Sepolia testnet — chainId 84532. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_NETWORK = "base-sepolia";
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";

/** Circle USDC on Base Sepolia (6 decimals) — the canonical x402 testnet asset. */
export const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

/** USDC EIP-712 domain name/version (Circle USDC standard). */
export const USDC_EIP712_NAME = "USDC";
export const USDC_EIP712_VERSION = "2";

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
//  Configuration
// ============================================================================

export interface MagicConnectorConfig {
  /** Magic user identity — the email the wallet is bound to. */
  readonly agentEmail: string;
  /** Supply an existing private key, or omit to generate a fresh one in-process. */
  readonly privateKey?: Hex;
  /** USDC token contract. Default: Circle USDC on Base Sepolia. */
  readonly tokenAddress?: Address;
  /** Chain id. Default: Base Sepolia (84532). */
  readonly chainId?: number;
  /** Storage adapter for (userId → Instrument). Use MemoryInstrumentStore in tests. */
  readonly instrumentStore: InstrumentStore;
  /** Optional clock override (tests). */
  readonly now?: () => number;
  /** Optional balance reader (Base Sepolia RPC) — passed through to the signer. */
  readonly balanceReader?: (address: Address) => Promise<bigint>;
  /** Optional broadcast hook — passed through to the signer for settle(). */
  readonly submit?: (input: {
    readonly signed: MagicSignedAuthorization;
  }) => Promise<{
    readonly transactionHash: string;
    readonly blockNumber?: number;
    readonly explorerUrl?: string;
  }>;
  /** Inject a pre-built signer (tests / shared identity). Overrides email/privateKey. */
  readonly signer?: RealMagicSigner;
}

// ============================================================================
//  Connector
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [
  {
    symbol: "USDC",
    decimals: 6,
    chain: "eip155:84532",
    contract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
];

export class MagicConnector implements WalletConnector {
  private readonly signer: RealMagicSigner;
  private readonly store: InstrumentStore;
  private readonly tokenAddress: Address;
  private readonly chainId: number;
  private readonly now: () => number;

  constructor(config: MagicConnectorConfig) {
    this.store = config.instrumentStore;
    this.tokenAddress = config.tokenAddress ?? BASE_SEPOLIA_USDC;
    this.chainId = config.chainId ?? BASE_SEPOLIA_CHAIN_ID;
    this.now = config.now ?? Date.now;

    if (config.signer) {
      this.signer = config.signer;
    } else {
      this.signer = new RealMagicSigner({
        email: config.agentEmail,
        ...(config.privateKey !== undefined ? { privateKey: config.privateKey } : {}),
        ...(config.balanceReader !== undefined
          ? { balanceReader: config.balanceReader }
          : {}),
        ...(config.submit !== undefined ? { submit: config.submit } : {}),
      });
    }
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Magic.link (Email Wallet)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [MAGIC_PROTOCOL],
      requiresUserApproval: false, // delegated session key — no per-payment magic-link
      settlesOnChain: true,
      typicalLatencyMs: 2000, // ~2s on Base L2
      features: {
        emailBased: true,
        evm: true,
        secp256k1: true,
        eip3009: true,
        nonCustodial: true,
        chain: BASE_SEPOLIA_NETWORK,
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

    const id = `payment-instrument-magic-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      // Email-based wallet: publicHandle = the derived 0x address.
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        email: this.signer.email, // ← Magic's user handle
        chainId: this.chainId,
        network: BASE_SEPOLIA_NETWORK,
        tokenAddress: this.tokenAddress,
        explorer: BASE_SEPOLIA_EXPLORER,
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
      asset: {
        symbol: "USDC",
        decimals: 6,
        chain: "eip155:84532",
        contract: this.tokenAddress,
      },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization. Produces a real, on-chain
   * verifiable EIP-712 signature. Does NOT broadcast.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== MAGIC_PROTOCOL) {
      throw new Error(
        `MagicConnector only supports protocol ${MAGIC_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (instrument.publicHandle.toLowerCase() !== this.signer.address.toLowerCase()) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match Magic wallet ${this.signer.address}`
      );
    }

    const authorization: Eip3009Authorization = {
      from: this.signer.address,
      to: input.request.recipient as Address,
      value: input.request.amount.amountAtomic,
      validAfter: input.request.validAfter,
      validBefore: input.request.validBefore,
      nonce: ensureHex32(input.request.nonce),
    };
    const domain: Eip712Domain = {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId: this.chainId,
      verifyingContract: this.tokenAddress,
    };

    const signed = await this.signer.signTransferAuthorization(authorization, domain);

    return {
      request: input.request,
      signer: this.signer.address,
      signature: signed.signature,
      extra: {
        signed,
        email: this.signer.email,
        chainId: this.chainId,
        verifyingContract: this.tokenAddress,
      },
    };
  }

  /**
   * Broadcast the signed authorization to Base Sepolia through the pluggable
   * `submit` hook. Offline-safe: with no hook configured, reports a structured
   * failure (no funds move) instead of silently succeeding.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireSigned = signed.extra?.["signed"] as
      | MagicSignedAuthorization
      | undefined;
    if (!wireSigned || !signed.signature) {
      return {
        success: false,
        network: BASE_SEPOLIA_NETWORK,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing signed authorization in signed.extra.signed",
      };
    }
    try {
      const result = await this.signer.broadcast(wireSigned);
      if (!result) {
        // Offline-safe default: signature is real but no broadcast hook wired.
        return {
          success: false,
          network: BASE_SEPOLIA_NETWORK,
          settledAt: nowIso(this.now()),
          errorCode: "rpc_error",
          errorMessage:
            "No broadcast hook configured (offline-safe). Wire MagicConnectorConfig.submit to settle on-chain.",
        };
      }
      return {
        success: true,
        transactionRef: result.transactionHash as TransactionRef,
        network: BASE_SEPOLIA_NETWORK,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          ...(result.blockNumber !== undefined
            ? { blockNumber: result.blockNumber }
            : {}),
          explorerUrl:
            result.explorerUrl ??
            `${BASE_SEPOLIA_EXPLORER}/tx/${result.transactionHash}`,
          email: this.signer.email,
        },
      };
    } catch (err) {
      return {
        success: false,
        network: BASE_SEPOLIA_NETWORK,
        settledAt: nowIso(this.now()),
        errorCode: "rpc_error",
        errorMessage: err instanceof Error ? err.message : String(err),
        raw: err,
      };
    }
  }

  // ---- Public helpers (useful for demos + tests) --------------------------

  get walletAddress(): Address {
    return this.signer.address;
  }

  get email(): string {
    return this.signer.email;
  }

  generateNonce(): Hex {
    return generateNonce();
  }

  // ---- Internals ----------------------------------------------------------

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) throw new Error(`Instrument not found: ${id}`);
    return i;
  }
}

// ============================================================================
//  Helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}

function ensureHex32(s: string): Hex {
  let v = s.startsWith("0x") ? s : "0x" + s;
  if (v.length < 66) {
    v = "0x" + v.slice(2).padStart(64, "0");
  } else if (v.length > 66) {
    v = "0x" + v.slice(2).slice(0, 64);
  }
  return v as Hex;
}

// Re-export to avoid unused-symbol lint on Money type import surface.
export type { Money };
