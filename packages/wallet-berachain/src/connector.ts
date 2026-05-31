/**
 * BerachainConnector — implements WalletConnector for self-custodial EVM
 * wallets on Berachain bArtio testnet (chainId 80084).
 *
 * Self-custodial model (same as wallet-base / wallet-hashkey):
 *   - The agent holds the EOA private key. In production it lives in AWS
 *     Secrets Manager + KMS and is loaded just-in-time.
 *   - If no key is supplied, the connector generates a fresh EVM keypair
 *     in-process (viem generatePrivateKey) — handy for demos / conformance.
 *
 * Settlement model:
 *   - signAuthorization() produces an off-chain EIP-712 signature (no chain I/O)
 *   - settle() broadcasts the signed authorization through a *facilitator*
 *     wallet (same EOA in demo, or a separate gas-paying EOA in production)
 *
 * Asset: USDC-style stablecoin on Berachain bArtio (6 decimals).
 * Protocol: x402-v1.
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
import {
  type Address,
  type Chain,
  type Hex,
  type WalletClient,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";

import {
  BERACHAIN_BARTIO_CHAIN_ID,
  BERACHAIN_BARTIO_USDC,
  berachainBartioChain,
  txExplorerUrl,
} from "./chain.js";
import {
  BerachainTokenClient,
  EIP712_TYPES,
  createWalletClientFromPrivateKey,
  generateNonce,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./token-client.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "berachain" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const BERACHAIN_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

/** CAIP-2 chain id string for Berachain bArtio. */
const CAIP2_CHAIN = "eip155:80084" as const;

// ============================================================================
//  Configuration
// ============================================================================

export interface BerachainConnectorConfig {
  /**
   * The agent's private key (Hex, 0x-prefixed). In production load from
   * AWS Secrets Manager. If omitted, a fresh keypair is generated in-process.
   */
  readonly privateKey?: Hex;
  /** Token contract address. Default: placeholder USDC on Berachain bArtio. */
  readonly tokenAddress?: Address;
  /** Chain to operate on. Default: Berachain bArtio. */
  readonly chain?: Chain;
  /** RPC override (e.g. private node). */
  readonly rpcUrl?: string;
  /**
   * Storage adapter for (userId → Instrument) bindings. In Lambda, back this
   * with DynamoDB. In tests, use {@link MemoryInstrumentStore}.
   */
  readonly instrumentStore: InstrumentStore;
  /**
   * Optional separate facilitator wallet for broadcasting (gas-payer).
   * If omitted, the agent's own wallet pays gas + broadcasts (simplest demo).
   */
  readonly facilitatorPrivateKey?: Hex;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
  /** Optional override for token client (for testing). */
  readonly tokenClient?: BerachainTokenClient;
  /**
   * EIP-712 domain `name` of the token. When provided, signing avoids a
   * network read of `name()` — required for fully-offline signing in tests.
   * Default: "USDC".
   */
  readonly tokenName?: string;
}

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
  { symbol: "USDC", decimals: 6, chain: CAIP2_CHAIN, contract: BERACHAIN_BARTIO_USDC },
];

export class BerachainConnector implements WalletConnector {
  private readonly tokenClient: BerachainTokenClient;
  private readonly agentAccount: PrivateKeyAccount;
  private readonly agentWallet: WalletClient;
  private readonly facilitatorWallet: WalletClient;
  private readonly facilitatorAccount: PrivateKeyAccount;
  private readonly store: InstrumentStore;
  private readonly chain: Chain;
  private readonly now: () => number;
  private readonly tokenName: string;

  constructor(config: BerachainConnectorConfig) {
    this.chain = config.chain ?? berachainBartioChain;
    this.now = config.now ?? Date.now;
    this.store = config.instrumentStore;
    this.tokenName = config.tokenName ?? "USDC";

    const tokenAddress = config.tokenAddress ?? BERACHAIN_BARTIO_USDC;

    // Agent wallet (signer of EIP-712 transferWithAuthorization).
    // Generate a fresh EVM keypair in-process when no key is supplied.
    const agentKey = config.privateKey ?? generatePrivateKey();
    const agent = createWalletClientFromPrivateKey(
      agentKey,
      this.chain,
      config.rpcUrl
    );
    this.agentWallet = agent.wallet;
    this.agentAccount = agent.account;

    // Facilitator wallet (broadcaster — pays gas; defaults to same as agent).
    if (config.facilitatorPrivateKey) {
      const fac = createWalletClientFromPrivateKey(
        config.facilitatorPrivateKey,
        this.chain,
        config.rpcUrl
      );
      this.facilitatorWallet = fac.wallet;
      this.facilitatorAccount = fac.account;
    } else {
      this.facilitatorWallet = this.agentWallet;
      this.facilitatorAccount = this.agentAccount;
    }

    this.tokenClient =
      config.tokenClient ??
      new BerachainTokenClient({
        tokenAddress,
        chain: this.chain,
        ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Berachain bArtio (Self-Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [BERACHAIN_PROTOCOL],
      requiresUserApproval: false, // private key in Secrets Manager → no UI prompt
      settlesOnChain: true,
      typicalLatencyMs: 2000, // ~2s block time on Berachain
      features: {
        gasInNativeToken: true, // gas paid in BERA
        instantFinality: false,
        sandboxAvailable: true,
        evmL1: true,
        proofOfLiquidity: true,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    // Idempotent: same userId → same instrument
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const id = `payment-instrument-berachain-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.agentAccount.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        chainId: this.chain.id,
        tokenAddress: this.tokenClient.tokenAddress,
        explorer: this.chain.blockExplorers?.default?.url,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const decimals = await this.tokenClient.getDecimals();
    const balanceWei = await this.tokenClient.getBalance(
      instrument.publicHandle as Address
    );
    return {
      instrumentId: instrument.id,
      asset: {
        symbol: "USDC",
        decimals,
        chain: CAIP2_CHAIN,
        contract: this.tokenClient.tokenAddress,
      },
      money: {
        amountAtomic: balanceWei.toString(),
        decimals,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization. Produces a SignedAuthorization
   * compatible with x402. Does NOT broadcast.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== BERACHAIN_PROTOCOL) {
      throw new Error(
        `BerachainConnector only supports protocol ${BERACHAIN_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (instrument.publicHandle !== this.agentAccount.address) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match agent wallet ${this.agentAccount.address}`
      );
    }

    const authorization: Eip3009Authorization = {
      from: this.agentAccount.address,
      to: input.request.recipient as Address,
      value: input.request.amount.amountAtomic,
      validAfter: input.request.validAfter,
      validBefore: input.request.validBefore,
      nonce: ensureHex32(input.request.nonce),
    };

    const signed = await this.tokenClient.signTransferAuthorization(
      this.agentAccount,
      authorization,
      this.tokenName
    );

    return {
      request: input.request,
      signer: this.agentAccount.address,
      signature: signed.signature,
      extra: {
        signed,
        chainId: this.chain.id,
        verifyingContract: this.tokenClient.tokenAddress,
        tokenName: this.tokenName,
      },
    };
  }

  /**
   * Broadcast the signed authorization to the chain. Returns SettlementResult
   * with on-chain tx hash + explorer link in `raw`.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireSigned = signed.extra?.["signed"] as
      | Eip3009SignedAuthorization
      | undefined;
    if (!wireSigned) {
      return {
        success: false,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing signed authorization in signed.extra.signed",
      };
    }
    try {
      const txHash = await this.tokenClient.broadcastSignedAuthorization(
        this.facilitatorWallet,
        wireSigned
      );
      const receipt = await this.tokenClient.waitForReceipt(txHash);
      if (receipt.status !== "success") {
        return {
          success: false,
          transactionRef: txHash as TransactionRef,
          network: this.chain.name,
          settledAt: nowIso(this.now()),
          errorCode: "rpc_error",
          errorMessage: `Tx reverted at block ${receipt.blockNumber}`,
          raw: receipt,
        };
      }
      return {
        success: true,
        transactionRef: txHash as TransactionRef,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          explorerUrl: txExplorerUrl(this.chain, txHash),
        },
      };
    } catch (err) {
      return {
        success: false,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        errorCode: "rpc_error",
        errorMessage: err instanceof Error ? err.message : String(err),
        raw: err,
      };
    }
  }

  // ---- Verification (real EIP-712 ecrecover via viem) ---------------------

  /**
   * Verify a SignedAuthorization produced by {@link signAuthorization}.
   * Returns true iff the signature recovers to the declared signer over the
   * exact EIP-712 typed-data (domain + message). Tampering with any field
   * (amount, recipient, nonce, …) makes this return false.
   */
  async verifyAuthorization(signed: SignedAuthorization): Promise<boolean> {
    const wire = signed.extra?.["signed"] as
      | Eip3009SignedAuthorization
      | undefined;
    if (!wire) return false;
    const name =
      (signed.extra?.["tokenName"] as string | undefined) ?? this.tokenName;
    const { authorization } = wire;
    try {
      return await verifyTypedData({
        address: signed.signer as Address,
        domain: {
          name,
          version: "2",
          chainId: BigInt(wire.chainId),
          verifyingContract: wire.verifyingContract,
        },
        types: EIP712_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
        signature: wire.signature,
      });
    } catch {
      return false;
    }
  }

  // ---- Public helpers (useful for demos + tests) --------------------------

  get agentAddress(): Address {
    return this.agentAccount.address;
  }

  get facilitatorAddress(): Address {
    return this.facilitatorAccount.address;
  }

  get chainId(): number {
    return this.chain.id;
  }

  generateNonce(): Hex {
    return generateNonce();
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

function ensureHex32(s: string): Hex {
  let v = s.startsWith("0x") ? s : "0x" + s;
  // Pad / truncate to 32 bytes hex (66 chars including 0x)
  if (v.length < 66) {
    v = "0x" + v.slice(2).padStart(64, "0");
  } else if (v.length > 66) {
    v = "0x" + v.slice(2).slice(0, 64);
  }
  return v as Hex;
}

// Re-export so the chainId constant is reachable from the connector module.
export { BERACHAIN_BARTIO_CHAIN_ID };

// Avoid Money-related lint warnings about unused symbol via re-export
export type { Money };
