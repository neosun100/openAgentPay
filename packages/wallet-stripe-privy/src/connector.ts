/**
 * StripePrivyConnector — implements WalletConnector for Stripe Privy managed
 * embedded wallets on EVM (Base Sepolia, x402-v1 / EIP-3009).
 * ============================================================================
 *
 * Positioning (per docs/POSITIONING.md): this connector EXTENDS AgentCore
 * Path-D. AgentCore Payments ships first-party support for Coinbase CDP and
 * Privy embedded wallets; OpenAgentPay mirrors the Privy managed-wallet model
 * so the same agent code works whether the embedded wallet is provisioned by
 * AgentCore or by OpenAgentPay's connector layer — closing Path-D parity for
 * non-CDP managed wallets.
 *
 * Custody model: MANAGED. Unlike wallet-hashkey (self-custodial EOA), the key
 * material conceptually lives in Privy's service. We model that with
 * {@link StripePrivyEmbeddedWallet}; `requiresUserApproval` is false because
 * the managed signer runs server-side with the app credential.
 *
 * Settlement model:
 *   - signAuthorization() → off-chain EIP-712 signature (no chain I/O)
 *   - settle() → broadcasts via a pluggable `submit` hook; default is
 *     offline-safe and returns a deterministic mock tx hash (0x + 64 hex).
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
import { type Address, type Hex, keccak256, stringToHex } from "viem";

import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  StripePrivyEmbeddedWallet,
  generateNonce,
  txExplorerUrl,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type StripePrivyConfig,
} from "./embedded-wallet.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "stripe-privy" as WalletProviderId;

/** OpenAgentPay canonical protocol id for EIP-3009 / x402 flows. */
export const STRIPE_PRIVY_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDC", decimals: 6, chain: "eip155:84532", contract: BASE_SEPOLIA_USDC },
];

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
//  Pluggable broadcast hook (settle)
// ============================================================================

/**
 * Production wires this to a facilitator that calls Circle USDC's
 * `transferWithAuthorization` on Base Sepolia (or to Privy's own sponsored-tx
 * API). If omitted, settle() is offline-safe and returns a deterministic mock
 * tx hash derived from the signature.
 */
export type SubmitHook = (
  signed: Eip3009SignedAuthorization
) => Promise<{ transactionRef: string; raw?: unknown }>;

/** Optional balance reader — wired to a Base Sepolia RPC in production. */
export type BalanceReader = (address: Address) => Promise<bigint>;

export interface StripePrivyConnectorConfig {
  /** Privy app credentials + embedded-wallet config (mock for tests/demo). */
  readonly privy: StripePrivyConfig;
  /** Storage adapter for (userId → Instrument) bindings. */
  readonly instrumentStore: InstrumentStore;
  /** Optional on-chain broadcast hook (settle). Default: offline mock tx hash. */
  readonly submit?: SubmitHook;
  /** Optional live balance reader. Default: returns 0 (offline-safe). */
  readonly balanceReader?: BalanceReader;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
}

// ============================================================================
//  Connector
// ============================================================================

export class StripePrivyConnector implements WalletConnector {
  private readonly embedded: StripePrivyEmbeddedWallet;
  private readonly store: InstrumentStore;
  private readonly submitHook: SubmitHook | undefined;
  private readonly balanceReader: BalanceReader | undefined;
  private readonly now: () => number;

  constructor(config: StripePrivyConnectorConfig) {
    this.embedded = new StripePrivyEmbeddedWallet(config.privy);
    this.store = config.instrumentStore;
    this.submitHook = config.submit;
    this.balanceReader = config.balanceReader;
    this.now = config.now ?? Date.now;
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Stripe Privy (Managed Embedded Wallet)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [STRIPE_PRIVY_PROTOCOL],
      requiresUserApproval: false, // managed signer runs server-side w/ app secret
      settlesOnChain: true,
      typicalLatencyMs: 2500, // Base L2 ~2s block time
      features: {
        managedWallet: true, // custodial / server-held key (vs self-custodial EOA)
        embeddedWallet: true,
        agentCorePathD: true, // closes parity with AgentCore Privy support
        gasSponsorship: true, // Privy can sponsor gas
        instantFinality: false,
        sandboxAvailable: true,
        chainId: BASE_SEPOLIA_CHAIN_ID,
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

    const id = `payment-instrument-stripe-privy-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.embedded.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        privyWalletId: this.embedded.wallet.id,
        chainType: this.embedded.wallet.chainType,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        tokenAddress: this.embedded.verifyingContract,
        custody: "managed",
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const atomic = this.balanceReader
      ? await this.balanceReader(instrument.publicHandle as Address)
      : 0n;
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDC", decimals: 6, contract: this.embedded.verifyingContract },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization through the managed embedded
   * wallet. Produces a SignedAuthorization compatible with x402. No broadcast.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== STRIPE_PRIVY_PROTOCOL) {
      throw new Error(
        `StripePrivyConnector only supports protocol ${STRIPE_PRIVY_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (instrument.publicHandle.toLowerCase() !== this.embedded.address.toLowerCase()) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match embedded wallet ${this.embedded.address}`
      );
    }

    const authorization: Eip3009Authorization = {
      from: this.embedded.address,
      to: input.request.recipient as Address,
      value: input.request.amount.amountAtomic,
      validAfter: input.request.validAfter,
      validBefore: input.request.validBefore,
      nonce: ensureHex32(input.request.nonce),
    };

    const signed = await this.embedded.signTransferAuthorization(authorization);

    return {
      request: input.request,
      signer: this.embedded.address,
      signature: signed.signature,
      extra: {
        signed,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        verifyingContract: this.embedded.verifyingContract,
        privyWalletId: this.embedded.wallet.id,
      },
    };
  }

  /**
   * Broadcast the signed authorization. Uses the pluggable `submit` hook if
   * present; otherwise returns a deterministic offline-safe mock tx hash so the
   * full sign→settle path is testable without a live RPC.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireSigned = signed.extra?.["signed"] as
      | Eip3009SignedAuthorization
      | undefined;
    if (!wireSigned || !signed.signature) {
      return {
        success: false,
        network: BASE_SEPOLIA_NETWORK,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing signed EIP-3009 authorization in signed.extra.signed",
      };
    }
    try {
      const { transactionRef, raw } = this.submitHook
        ? await this.submitHook(wireSigned)
        : { transactionRef: mockTxHash(signed.signature), raw: { offline: true } };

      return {
        success: true,
        transactionRef: transactionRef as TransactionRef,
        network: BASE_SEPOLIA_NETWORK,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          ...(raw && typeof raw === "object" ? raw : { raw }),
          explorerUrl: txExplorerUrl(transactionRef),
          privyWalletId: this.embedded.wallet.id,
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

  // ---- Public helpers (demos + tests) -------------------------------------

  /** The embedded wallet's EVM address (0x, 40 hex). */
  get walletAddress(): Address {
    return this.embedded.address;
  }

  /** The Privy-side wallet id. */
  get privyWalletId(): string {
    return this.embedded.wallet.id;
  }

  generateNonce(): Hex {
    return generateNonce();
  }

  // ---- Internals ----------------------------------------------------------

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

/**
 * Deterministic offline mock tx hash (0x + 64 hex) derived from the signature.
 * Stable for a given signature so tests can assert reproducibility; clearly not
 * a real on-chain hash (production routes through the `submit` hook instead).
 */
function mockTxHash(signature: string): Hex {
  return keccak256(stringToHex(`oap-stripe-privy-offline:${signature}`));
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

// Re-export Money to mirror sibling connectors' lint-quiet pattern.
export type { Money };
