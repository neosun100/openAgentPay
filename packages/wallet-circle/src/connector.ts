/**
 * CircleConnector — implements WalletConnector for Circle Programmable Wallets
 * in "developer-controlled" mode.
 * ============================================================================
 *
 * Custody model:
 *   - Config carries a (mock) Circle apiKey + entitySecret.
 *   - The connector derives the agent's EVM wallet keypair IN-PROCESS from
 *     (entitySecret, walletSalt) — emulating Circle's server-side derivation.
 *   - publicHandle = the derived 0x address (real, checksummed secp256k1 addr).
 *
 * Payment model (x402-v1 / EIP-3009):
 *   - signAuthorization() → real EIP-712 transferWithAuthorization signature,
 *     no chain I/O. Verifiable on-chain by USDC's `ecrecover`.
 *   - settle() → broadcasts via Circle's gas-station-sponsored transfer
 *     (pluggable `submit` hook). Offline default → deterministic mock tx hash.
 *
 * Distinctive Circle capability: USDC-native + gas-station (gas sponsored in
 * USDC / by Circle), surfaced as `features.gasStation = true`.
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
import type { Address } from "viem";

import { resolveCircleChain, type CircleNetwork } from "./chain.js";
import {
  RealCircleSigner,
  ensureHex32,
  generateNonce,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "circle" as WalletProviderId;

/** OpenAgentPay canonical protocol id for EIP-3009 flows. */
export const CIRCLE_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

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
//  Config
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "USDC", decimals: 6 }];

export interface CircleConnectorConfig {
  /**
   * Circle API key (mock in offline/test mode). Developer-controlled wallets
   * authenticate API calls with this; the connector only records it as
   * provider metadata since signing is local.
   */
  readonly apiKey: string;
  /**
   * Circle entity secret (32-byte hex). Used to derive the agent wallet
   * keypair. NEVER commit a real one — load from Secrets Manager in prod.
   */
  readonly entitySecret: string;
  /**
   * Salt for per-wallet derivation (walletSetId). Defaults to a fixed value;
   * override per agent/tenant for distinct wallets.
   */
  readonly walletSalt?: string;
  /** Which testnet to operate on. Default: base-sepolia. */
  readonly network?: CircleNetwork;
  /**
   * Whether gas-station sponsorship is enabled (Circle pays gas, agent pays
   * only USDC). Surfaced in capabilities and passed to broadcast.
   */
  readonly gasStation?: boolean;
  /** Storage adapter for (userId → Instrument). */
  readonly instrumentStore: InstrumentStore;
  /** Optional pre-built signer (for tests / custom derivation). */
  readonly signer?: RealCircleSigner;
  /** Optional clock override (tests). */
  readonly now?: () => number;
}

// ============================================================================
//  Connector
// ============================================================================

export class CircleConnector implements WalletConnector {
  private readonly signer: RealCircleSigner;
  private readonly store: InstrumentStore;
  private readonly network: CircleNetwork;
  private readonly gasStation: boolean;
  private readonly apiKey: string;
  private readonly now: () => number;

  constructor(config: CircleConnectorConfig) {
    if (!config.instrumentStore) {
      throw new Error("CircleConnector: instrumentStore is required");
    }
    this.store = config.instrumentStore;
    this.network = config.network ?? "base-sepolia";
    this.gasStation = config.gasStation ?? true;
    this.apiKey = config.apiKey;
    this.now = config.now ?? Date.now;

    this.signer =
      config.signer ??
      new RealCircleSigner({
        entitySecret: config.entitySecret,
        walletSalt: config.walletSalt ?? "openagentpay-default-wallet-set",
        network: this.network,
      });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    const info = resolveCircleChain(this.network);
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Circle Programmable Wallets (Developer-Controlled)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [CIRCLE_PROTOCOL],
      requiresUserApproval: false, // developer-controlled → no end-user prompt
      settlesOnChain: true,
      typicalLatencyMs: 2500, // ~2.5s with gas-station sponsorship
      features: {
        gasStation: this.gasStation, // Circle pays gas / gas-in-USDC
        usdcNative: true,
        developerControlled: true,
        chainId: info.chain.id,
        network: this.network,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const info = resolveCircleChain(this.network);
    const id = `payment-instrument-circle-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        chainId: info.chain.id,
        usdc: info.usdc,
        gasStation: this.gasStation,
        // Record the key id, never the secret. apiKey kept only as a presence flag.
        apiKeyConfigured: this.apiKey.length > 0,
        explorer: info.chain.blockExplorers?.default?.url,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const info = resolveCircleChain(this.network);
    const atomic = await this.signer.getBalance();
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDC", decimals: 6, contract: info.usdc },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization. Real EIP-712 signature,
   * no broadcast. Throws on wrong protocol or unknown instrument.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== CIRCLE_PROTOCOL) {
      throw new Error(
        `CircleConnector only supports protocol ${CIRCLE_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (instrument.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match Circle wallet ${this.signer.address}`
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

    const signed = await this.signer.signTransferAuthorization(authorization);
    const info = resolveCircleChain(this.network);

    return {
      request: input.request,
      signer: this.signer.address,
      signature: signed.signature,
      extra: {
        signed,
        chainId: info.chain.id,
        verifyingContract: info.usdc,
        network: this.network,
        gasStation: this.gasStation,
      },
    };
  }

  /**
   * Broadcast via Circle gas-station transfer (pluggable). Offline default →
   * deterministic mock tx hash.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireSigned = signed.extra?.["signed"] as
      | Eip3009SignedAuthorization
      | undefined;
    const networkName = `circle-${this.network}`;
    if (!wireSigned) {
      return {
        success: false,
        network: networkName,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing signed authorization in signed.extra.signed",
      };
    }
    try {
      const result = await this.signer.broadcast(wireSigned, this.gasStation);
      return {
        success: true,
        transactionRef: result.transactionHash as TransactionRef,
        network: networkName,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          explorerUrl: result.explorerUrl,
          gasStation: this.gasStation,
          ...(result.raw !== undefined ? { providerRaw: result.raw } : {}),
        },
      };
    } catch (err) {
      return {
        success: false,
        network: networkName,
        settledAt: nowIso(this.now()),
        errorCode: "rpc_error",
        errorMessage: err instanceof Error ? err.message : String(err),
        raw: err,
      };
    }
  }

  // ---- Public helpers ------------------------------------------------------

  get walletAddress(): Address {
    return this.signer.address;
  }

  generateNonce() {
    return generateNonce();
  }

  // ---- Internals -----------------------------------------------------------

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
