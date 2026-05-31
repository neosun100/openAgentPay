/**
 * BlastSepoliaConnector — implements WalletConnector for self-custodial EVM
 * wallets on Blast Sepolia (Blast's OP-Stack-derived L2 testnet, chainId
 * 168587773).
 *
 * Self-custodial model (same as wallet-base):
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
 * Asset: USDC on Blast Sepolia (6 decimals placeholder). Protocol: x402-v1.
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
import { type Address, type Chain, type Hex, type WalletClient } from "viem";
import { generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";

import {
  BLAST_SEPOLIA_CHAIN_ID,
  BLAST_SEPOLIA_USDC,
  blastSepoliaChain,
  txExplorerUrl,
} from "./chain.js";
import {
  BlastTokenClient,
  createWalletClientFromPrivateKey,
  generateNonce,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./token-client.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "blast" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const BLAST_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

// ============================================================================
//  Configuration
// ============================================================================

export interface BlastSepoliaConnectorConfig {
  /**
   * The agent's private key (Hex, 0x-prefixed). In production load from
   * AWS Secrets Manager. If omitted, a fresh keypair is generated in-process.
   */
  readonly privateKey?: Hex;
  /** Token contract address. Default: USDC placeholder on Blast Sepolia. */
  readonly tokenAddress?: Address;
  /** Chain to operate on. Default: Blast Sepolia. */
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
  readonly tokenClient?: BlastTokenClient;
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
  { symbol: "USDC", decimals: 6, chain: "eip155:168587773", contract: BLAST_SEPOLIA_USDC },
];

export class BlastSepoliaConnector implements WalletConnector {
  private readonly tokenClient: BlastTokenClient;
  private readonly agentAccount: PrivateKeyAccount;
  private readonly agentWallet: WalletClient;
  private readonly facilitatorWallet: WalletClient;
  private readonly facilitatorAccount: PrivateKeyAccount;
  private readonly store: InstrumentStore;
  private readonly chain: Chain;
  private readonly now: () => number;

  constructor(config: BlastSepoliaConnectorConfig) {
    this.chain = config.chain ?? blastSepoliaChain;
    this.now = config.now ?? Date.now;
    this.store = config.instrumentStore;

    const tokenAddress = config.tokenAddress ?? BLAST_SEPOLIA_USDC;

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
      new BlastTokenClient({
        tokenAddress,
        chain: this.chain,
        ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Blast Sepolia (Self-Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [BLAST_PROTOCOL],
      requiresUserApproval: false, // private key in Secrets Manager → no UI prompt
      settlesOnChain: true,
      typicalLatencyMs: 2000, // ~2s block time on Blast L2
      features: {
        gasInNativeToken: true,
        instantFinality: false, // L2, ~2s block time
        sandboxAvailable: true,
        evmL2: true,
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

    const id = `payment-instrument-blast-${input.userId}` as InstrumentId;
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
        chain: "eip155:168587773",
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
    if (input.request.protocol !== BLAST_PROTOCOL) {
      throw new Error(
        `BlastSepoliaConnector only supports protocol ${BLAST_PROTOCOL}, got ${input.request.protocol}`
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
      authorization
    );

    return {
      request: input.request,
      signer: this.agentAccount.address,
      signature: signed.signature,
      extra: {
        signed,
        chainId: this.chain.id,
        verifyingContract: this.tokenClient.tokenAddress,
      },
    };
  }

  /**
   * Broadcast the signed authorization to the chain. Returns SettlementResult
   * with on-chain tx hash + explorer link in `raw`.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireSigned = signed.extra?.["signed"] as Eip3009SignedAuthorization | undefined;
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
export { BLAST_SEPOLIA_CHAIN_ID };

// Avoid Money-related lint warnings about unused symbol via re-export
export type { Money };
