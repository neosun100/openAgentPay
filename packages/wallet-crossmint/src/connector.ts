/**
 * CrossmintConnector — implements WalletConnector for Crossmint embedded wallets.
 * ============================================================================
 *
 * Crossmint (https://crossmint.com) provisions NFT-aware, non-custodial
 * *embedded* EVM wallets keyed to a developer's `apiKey` + `projectId`. From
 * OpenAgentPay's perspective Crossmint is "an EVM account that signs EIP-712"
 * — so this connector reuses the same x402 / EIP-3009 flow as wallet-magic /
 * wallet-hashkey, but keys the agent wallet identity to the *project
 * credentials* rather than an email or raw private key.
 *
 *   - Identity        : config.apiKey + config.projectId (in providerMetadata)
 *   - publicHandle    : 0x checksummed address derived (HKDF) from the creds
 *   - Asset           : USDC on Base Sepolia (6 decimals)
 *   - signAuthorization: EIP-712 EIP-3009 transferWithAuthorization (real sig)
 *   - settle          : pluggable broadcast hook (offline-safe default)
 *
 * Capability flags: nftAware=true (Crossmint's headline feature — wallets hold
 * and transfer NFTs natively), embedded=true, requiresUserApproval=false (the
 * agent holds a delegated project key; no interactive prompt per payment).
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
  type CrossmintSignedAuthorization,
  type Eip3009Authorization,
  type Eip712Domain,
  RealCrossmintSigner,
  generateNonce,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "crossmint" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const CROSSMINT_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

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

export interface CrossmintConnectorConfig {
  /** Crossmint server-side API key (mock value fine offline). */
  readonly apiKey: string;
  /** Crossmint project id the embedded wallet is scoped to. */
  readonly projectId: string;
  /** Supply an existing private key to bypass derivation (tests / shared identity). */
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
    readonly signed: CrossmintSignedAuthorization;
  }) => Promise<{
    readonly transactionHash: string;
    readonly blockNumber?: number;
    readonly explorerUrl?: string;
  }>;
  /** Inject a pre-built signer (tests / shared identity). Overrides creds/privateKey. */
  readonly signer?: RealCrossmintSigner;
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

export class CrossmintConnector implements WalletConnector {
  private readonly signer: RealCrossmintSigner;
  private readonly store: InstrumentStore;
  private readonly tokenAddress: Address;
  private readonly chainId: number;
  private readonly now: () => number;

  constructor(config: CrossmintConnectorConfig) {
    this.store = config.instrumentStore;
    this.tokenAddress = config.tokenAddress ?? BASE_SEPOLIA_USDC;
    this.chainId = config.chainId ?? BASE_SEPOLIA_CHAIN_ID;
    this.now = config.now ?? Date.now;

    if (config.signer) {
      this.signer = config.signer;
    } else {
      this.signer = new RealCrossmintSigner({
        apiKey: config.apiKey,
        projectId: config.projectId,
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
      displayName: "Crossmint (NFT-aware Embedded Wallet)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [CROSSMINT_PROTOCOL],
      requiresUserApproval: false, // delegated project key — no per-payment prompt
      settlesOnChain: true,
      typicalLatencyMs: 2000, // ~2s on Base L2
      features: {
        nftAware: true, // Crossmint's headline feature — native NFT custody/transfer
        embedded: true,
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

    const id = `payment-instrument-crossmint-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      // Embedded wallet: publicHandle = the derived 0x address.
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        projectId: this.signer.projectId, // ← Crossmint's wallet scope
        // NOTE: apiKey is a secret — we record only its provenance, not the value.
        apiKeyConfigured: true,
        chainId: this.chainId,
        network: BASE_SEPOLIA_NETWORK,
        tokenAddress: this.tokenAddress,
        explorer: BASE_SEPOLIA_EXPLORER,
        nftAware: true,
        embedded: true,
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
    if (input.request.protocol !== CROSSMINT_PROTOCOL) {
      throw new Error(
        `CrossmintConnector only supports protocol ${CROSSMINT_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (
      instrument.publicHandle.toLowerCase() !== this.signer.address.toLowerCase()
    ) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match Crossmint wallet ${this.signer.address}`
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

    const signed = await this.signer.signTransferAuthorization(
      authorization,
      domain
    );

    return {
      request: input.request,
      signer: this.signer.address,
      signature: signed.signature,
      extra: {
        signed,
        projectId: this.signer.projectId,
        chainId: this.chainId,
        verifyingContract: this.tokenAddress,
        nftAware: true,
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
      | CrossmintSignedAuthorization
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
            "No broadcast hook configured (offline-safe). Wire CrossmintConnectorConfig.submit to settle on-chain.",
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
          projectId: this.signer.projectId,
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

  get projectId(): string {
    return this.signer.projectId;
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
