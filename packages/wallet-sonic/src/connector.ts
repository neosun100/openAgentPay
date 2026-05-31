/**
 * SonicConnector — implements WalletConnector for self-custodial EVM wallets on
 * Sonic Blaze testnet (Sonic = ex-Fantom Opera, a high-throughput EVM L1;
 * chainId 57054).
 *
 * Self-custodial model (mirrors wallet-base / wallet-hashkey):
 *   - The agent holds the EOA private key. In production it lives in AWS
 *     Secrets Manager + KMS and is loaded just-in-time.
 *   - If no key is supplied, the connector generates a fresh EVM keypair
 *     in-process (viem generatePrivateKey) — handy for demos / conformance.
 *
 * Settlement model:
 *   - signAuthorization() produces an off-chain EIP-712 signature (no chain I/O)
 *   - settle() broadcasts the signed authorization through a *pluggable*
 *     broadcaster. The default broadcaster is an offline-safe mock so the suite
 *     runs without RPC; pass `broadcast: "chain"` to broadcast on-chain via a
 *     facilitator wallet.
 *
 * Asset: USDC-shaped EIP-3009 ERC-20 on Sonic Blaze (6 decimals, placeholder
 * address until Circle ships a canonical deployment). Protocol: x402-v1.
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
  SONIC_BLAZE_CHAIN_ID,
  SONIC_BLAZE_USDC,
  sonicBlazeChain,
  txExplorerUrl,
} from "./chain.js";
import {
  SonicTokenClient,
  createWalletClientFromPrivateKey,
  generateNonce,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./token-client.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "sonic" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const SONIC_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

/**
 * Default EIP-712 domain name used for offline signing. Real Circle USDC
 * reports "USD Coin"; the placeholder token uses the same so the signing path
 * is byte-for-byte identical. Overridable via config when a real token is set.
 */
const DEFAULT_DOMAIN_NAME = "USD Coin";

/** Broadcast strategy: offline mock (default, RPC-free) or real on-chain. */
export type SonicBroadcastMode = "mock" | "chain";

// ============================================================================
//  Configuration
// ============================================================================

export interface SonicConnectorConfig {
  /**
   * The agent's private key (Hex, 0x-prefixed). In production load from
   * AWS Secrets Manager. If omitted, a fresh keypair is generated in-process.
   */
  readonly privateKey?: Hex;
  /** Token contract address. Default: USDC placeholder on Sonic Blaze. */
  readonly tokenAddress?: Address;
  /** Chain to operate on. Default: Sonic Blaze testnet. */
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
  /**
   * Broadcast strategy for settle(). "mock" (default) returns a synthetic but
   * structurally valid SettlementResult without touching the network — keeps
   * the connector offline-safe. "chain" broadcasts via the token contract.
   */
  readonly broadcast?: SonicBroadcastMode;
  /**
   * EIP-712 domain name override. Defaults to "USD Coin" so offline signing
   * does not require an RPC `name()` read.
   */
  readonly domainName?: string;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
  /** Optional override for token client (for testing). */
  readonly tokenClient?: SonicTokenClient;
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
  { symbol: "USDC", decimals: 6, chain: "eip155:57054", contract: SONIC_BLAZE_USDC },
];

export class SonicConnector implements WalletConnector {
  private readonly tokenClient: SonicTokenClient;
  private readonly agentAccount: PrivateKeyAccount;
  private readonly agentWallet: WalletClient;
  private readonly facilitatorWallet: WalletClient;
  private readonly facilitatorAccount: PrivateKeyAccount;
  private readonly store: InstrumentStore;
  private readonly chain: Chain;
  private readonly broadcastMode: SonicBroadcastMode;
  private readonly domainName: string;
  private readonly now: () => number;

  constructor(config: SonicConnectorConfig) {
    this.chain = config.chain ?? sonicBlazeChain;
    this.now = config.now ?? Date.now;
    this.store = config.instrumentStore;
    this.broadcastMode = config.broadcast ?? "mock";
    this.domainName = config.domainName ?? DEFAULT_DOMAIN_NAME;

    const tokenAddress = config.tokenAddress ?? SONIC_BLAZE_USDC;

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
      new SonicTokenClient({
        tokenAddress,
        chain: this.chain,
        domainName: this.domainName,
        ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Sonic Blaze (Self-Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [SONIC_PROTOCOL],
      requiresUserApproval: false, // private key in Secrets Manager → no UI prompt
      settlesOnChain: true,
      typicalLatencyMs: 1000, // sub-second finality on Sonic
      features: {
        gasInNativeToken: true, // gas paid in S
        instantFinality: true, // sub-second on Sonic
        sandboxAvailable: true,
        evmL1: true,
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

    const id = `payment-instrument-sonic-${input.userId}` as InstrumentId;
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
        chain: "eip155:57054",
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
    if (input.request.protocol !== SONIC_PROTOCOL) {
      throw new Error(
        `SonicConnector only supports protocol ${SONIC_PROTOCOL}, got ${input.request.protocol}`
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
        domainName: this.domainName,
      },
    };
  }

  /**
   * Settle the signed authorization. Default ("mock") returns an offline-safe
   * synthetic result so the connector works without RPC. ("chain") broadcasts
   * the signed authorization on-chain via the facilitator wallet.
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

    // Offline-safe mock broadcast (default). Derives a deterministic synthetic
    // tx ref from the signature so it is structurally valid without network.
    if (this.broadcastMode === "mock") {
      const mockTxHash = ("0x" + wireSigned.signature.slice(2, 66)) as Hex;
      return {
        success: true,
        transactionRef: mockTxHash as TransactionRef,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          mode: "mock",
          note: "offline mock broadcast — set broadcast:'chain' to settle on-chain",
          explorerUrl: txExplorerUrl(this.chain, mockTxHash),
        },
      };
    }

    // Real on-chain broadcast.
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
export { SONIC_BLAZE_CHAIN_ID };

// Avoid Money-related lint warnings about unused symbol via re-export
export type { Money };
