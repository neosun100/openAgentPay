/**
 * FireblocksConnector — WalletConnector for Fireblocks institutional MPC custody.
 * ============================================================================
 *
 * Fireblocks is OpenAgentPay's **institutional custody** story: keys are
 * MPC-CMP sharded across a co-signer cluster, every transaction is gated by the
 * on-platform **Policy Engine (TAP)**, and authorization runs through the
 * Fireblocks API rather than a locally-held key. There is no interactive
 * end-user prompt — policy approval is automatic for in-policy transactions —
 * so `requiresUserApproval:false`.
 *
 * Identity model:
 *   - VAULT ACCOUNT     — a Fireblocks vault (vaultAccountId, e.g. "0").
 *   - VAULT ASSET ADDR  — the EVM deposit address of USDC under that vault;
 *                         this is the merchant-visible sender. `publicHandle`
 *                         = 0x address; `vaultAccountId` lives in metadata.
 *
 * Flow over the 5-method contract:
 *   - signAuthorization() → builds an EIP-3009 transferWithAuthorization and
 *     signs it (real EIP-712 secp256k1; the key is the MPC stand-in offline).
 *     NO broadcast. Returns the signature + r/s/v + vault metadata in `extra`.
 *   - settle() → in production submits a policy-gated Fireblocks transaction
 *     via the pluggable `submit` hook (MPC co-sign); offline returns a
 *     deterministic mock Fireblocks tx id as the transactionRef.
 *
 * Asset: USDC on Base Sepolia (6 decimals) + ETH (advertised, gas).
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
import { type Address } from "viem";

import {
  BASE_SEPOLIA_USDC,
  ensureHex32,
  RealFireblocksSigner,
  type Eip3009Authorization,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "fireblocks" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EVM stablecoin flows. */
export const FIREBLOCKS_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

export const NETWORK_NAME = "base-sepolia";

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDC", decimals: 6, chain: "eip155:84532", contract: BASE_SEPOLIA_USDC },
  { symbol: "ETH", decimals: 18, chain: "eip155:84532" },
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
//  Connector
// ============================================================================

export interface FireblocksConnectorConfig {
  /** The MPC-stand-in EVM signer bound to a Fireblocks vault asset. */
  readonly signer: RealFireblocksSigner;
  readonly instrumentStore: InstrumentStore;
  /** USDC token address override (default Base Sepolia USDC). */
  readonly tokenAddress?: Address;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
}

export class FireblocksConnector implements WalletConnector {
  private readonly signer: RealFireblocksSigner;
  private readonly store: InstrumentStore;
  private readonly tokenAddress: Address;
  private readonly now: () => number;

  constructor(cfg: FireblocksConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.tokenAddress = cfg.tokenAddress ?? this.signer.tokenAddress;
    this.now = cfg.now ?? Date.now;
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Fireblocks (Institutional MPC Custody)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [FIREBLOCKS_PROTOCOL],
      // Policy Engine (TAP) governs approvals — no interactive end-user prompt.
      requiresUserApproval: false,
      settlesOnChain: true,
      typicalLatencyMs: 4000, // MPC co-sign + bundler/RPC inclusion on Base L2
      features: {
        mpc: true,
        institutional: true,
        custody: true,
        policyEngine: true,
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

    const id = `payment-instrument-fireblocks-${input.userId}` as InstrumentId;
    // publicHandle = the vault asset's EVM address (merchant-visible sender);
    // vaultAccountId + apiKey-presence flag live in providerMetadata.
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        vaultAccountId: this.signer.vaultAccountId,
        address: this.signer.address,
        chainId: this.signer.chainId,
        tokenAddress: this.tokenAddress,
        custodyModel: "mpc-cmp",
        policyEngine: "TAP",
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
   * Sign an EIP-3009 transferWithAuthorization with the vault signing identity.
   * Produces a real EIP-712 secp256k1 signature. Does NOT broadcast.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== FIREBLOCKS_PROTOCOL) {
      throw new Error(
        `FireblocksConnector only supports protocol ${FIREBLOCKS_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (instrument.publicHandle.toLowerCase() !== this.signer.address.toLowerCase()) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match vault address ${this.signer.address}`
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

    return {
      request: input.request,
      // signer = the vault asset EVM address (the on-chain authorizing entity).
      signer: this.signer.address,
      signature: signed.signature,
      extra: {
        vaultAccountId: this.signer.vaultAccountId,
        custodyModel: "mpc-cmp",
        policyEngine: "TAP",
        v: signed.v,
        r: signed.r,
        s: signed.s,
        chainId: signed.chainId,
        verifyingContract: signed.verifyingContract,
        domainName: signed.domainName,
        authorization,
      },
    };
  }

  /**
   * Submit the signed authorization. In production the `submit` hook on the
   * signer creates a policy-gated Fireblocks transaction (MPC co-sign) and
   * returns a real Fireblocks tx id + on-chain hash. Offline: returns a
   * deterministic mock Fireblocks tx id as transactionRef.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: NETWORK_NAME,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing vault signature",
      };
    }
    const extra = (signed.extra ?? {}) as Record<string, unknown>;
    const authorization = extra["authorization"] as
      | Eip3009Authorization
      | undefined;
    if (!authorization) {
      return {
        success: false,
        network: NETWORK_NAME,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing EIP-3009 authorization in signed.extra",
      };
    }

    const result = await this.signer.submitTransaction({
      authorization,
      signature: signed.signature as `0x${string}`,
      v: (extra["v"] as number) ?? 0,
      r: (extra["r"] as `0x${string}`) ?? "0x",
      s: (extra["s"] as `0x${string}`) ?? "0x",
      chainId: (extra["chainId"] as number) ?? this.signer.chainId,
      verifyingContract:
        (extra["verifyingContract"] as Address) ?? this.tokenAddress,
      domainName: (extra["domainName"] as string) ?? "USD Coin",
    });

    return {
      success: true,
      // Fireblocks transaction id is the canonical settlement reference.
      transactionRef: result.fireblocksTxId as TransactionRef,
      network: NETWORK_NAME,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        fireblocksTxId: result.fireblocksTxId,
        ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
        vaultAccountId: this.signer.vaultAccountId,
        policyAutoApproved: this.signer.policyAutoApproved,
      },
    };
  }

  // ---- Public helpers (useful for demos + tests) --------------------------

  get vaultAddress(): Address {
    return this.signer.address;
  }

  get vaultAccountId(): string {
    return this.signer.vaultAccountId;
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
