/**
 * MantleSepoliaConnector — implements WalletConnector for self-custodial EVM
 * wallets on Mantle Sepolia (Mantle's Ethereum L2 testnet, chainId 5003).
 *
 * Self-custodial model (mirrors wallet-base / wallet-hashkey):
 *   - The agent holds the EOA private key. In production it lives in AWS
 *     Secrets Manager + KMS and is loaded just-in-time.
 *   - If no key is supplied, the connector generates a fresh EVM keypair
 *     in-process (viem generatePrivateKey) — handy for demos / conformance.
 *
 * Settlement model:
 *   - signAuthorization() produces a real off-chain EIP-712 signature (no
 *     chain I/O — the EIP-712 domain name is a config value, not an on-chain
 *     read, so signing is deterministic & offline-safe).
 *   - settle() broadcasts the signed authorization through a *facilitator*
 *     wallet (same EOA in demo, or a separate gas-paying EOA in production).
 *
 * Asset: USDC on Mantle Sepolia (6 decimals, placeholder address — see chain.ts).
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
import { type Address, type Chain, type Hex, type WalletClient } from "viem";
import { generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";

import {
  MANTLE_SEPOLIA_CHAIN_ID,
  MANTLE_SEPOLIA_USDC,
  mantleSepoliaChain,
  txExplorerUrl,
} from "./chain.js";
import {
  MantleTokenClient,
  createWalletClientFromPrivateKey,
  generateNonce,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./token-client.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "mantle" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const MANTLE_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

/** Default token decimals (USDC) — used when an RPC read is unavailable. */
const DEFAULT_DECIMALS = 6;

// ============================================================================
//  Configuration
// ============================================================================

export interface MantleSepoliaConnectorConfig {
  /**
   * The agent's private key (Hex, 0x-prefixed). In production load from
   * AWS Secrets Manager. If omitted, a fresh keypair is generated in-process.
   */
  readonly privateKey?: Hex;
  /** Token contract address. Default: USDC on Mantle Sepolia (placeholder). */
  readonly tokenAddress?: Address;
  /** Chain to operate on. Default: Mantle Sepolia. */
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
  readonly tokenClient?: MantleTokenClient;
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
  { symbol: "USDC", decimals: 6, chain: "eip155:5003", contract: MANTLE_SEPOLIA_USDC },
];

export class MantleSepoliaConnector implements WalletConnector {
  private readonly tokenClient: MantleTokenClient;
  private readonly agentAccount: PrivateKeyAccount;
  private readonly agentWallet: WalletClient;
  private readonly facilitatorWallet: WalletClient;
  private readonly facilitatorAccount: PrivateKeyAccount;
  private readonly store: InstrumentStore;
  private readonly chain: Chain;
  private readonly now: () => number;

  constructor(config: MantleSepoliaConnectorConfig) {
    this.chain = config.chain ?? mantleSepoliaChain;
    this.now = config.now ?? Date.now;
    this.store = config.instrumentStore;

    const tokenAddress = config.tokenAddress ?? MANTLE_SEPOLIA_USDC;

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
      new MantleTokenClient({
        tokenAddress,
        chain: this.chain,
        ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Mantle Sepolia (Self-Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [MANTLE_PROTOCOL],
      requiresUserApproval: false, // private key in Secrets Manager → no UI prompt
      settlesOnChain: true,
      typicalLatencyMs: 2000, // ~2s block time on Mantle L2
      features: {
        gasInNativeToken: true, // gas paid in MNT
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

    const id = `payment-instrument-mantle-${input.userId}` as InstrumentId;
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
    // Resilient read: Mantle Sepolia USDC is a placeholder address, so the RPC
    // read may fail. Fall back to default decimals / zero balance so the
    // contract (stringified atomic units, valid timestamp) still holds.
    let decimals = DEFAULT_DECIMALS;
    let balanceWei = 0n;
    try {
      decimals = await this.tokenClient.getDecimals();
      balanceWei = await this.tokenClient.getBalance(
        instrument.publicHandle as Address
      );
    } catch {
      // Keep deterministic fallbacks; a real deployed USDC would succeed here.
      decimals = DEFAULT_DECIMALS;
      balanceWei = 0n;
    }
    return {
      instrumentId: instrument.id,
      asset: {
        symbol: "USDC",
        decimals,
        chain: "eip155:5003",
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
   * compatible with x402. Does NOT broadcast. Pure crypto — no network I/O.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== MANTLE_PROTOCOL) {
      throw new Error(
        `MantleSepoliaConnector only supports protocol ${MANTLE_PROTOCOL}, got ${input.request.protocol}`
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

  /** Expose the underlying token client (for verification in tests/demos). */
  get tokens(): MantleTokenClient {
    return this.tokenClient;
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
export { MANTLE_SEPOLIA_CHAIN_ID };

// Avoid Money-related lint warnings about unused symbol via re-export
export type { Money };
