/**
 * RoninSaigonConnector — implements WalletConnector for self-custodial EVM
 * wallets on Ronin Saigon testnet (Sky Mavis's Axie Infinity sidechain,
 * chainId 2021 per the OpenAgentPay spec).
 *
 * Self-custodial model (same as wallet-base / wallet-hashkey):
 *   - The agent holds the EOA private key. In production it lives in AWS
 *     Secrets Manager + KMS and is loaded just-in-time.
 *   - If no key is supplied, the connector generates a fresh EVM keypair
 *     in-process (viem generatePrivateKey) — handy for demos / conformance.
 *
 * Ronin addresses: displayed as `ronin:<hex>` but identical to `0x<hex>` EVM
 * addresses. This connector uses canonical 0x everywhere (signing, recovery,
 * RPC); {@link RoninSaigonConnector.roninDisplayAddress} is cosmetic only.
 *
 * Settlement model:
 *   - signAuthorization() produces an off-chain EIP-712 signature (no chain I/O)
 *     and self-verifies it via off-chain ecrecover before returning.
 *   - settle() broadcasts the signed authorization through a *facilitator*
 *     wallet (same EOA in demo, or a separate gas-paying EOA in production).
 *     Offline-safe: a pluggable broadcaster defaults to a deterministic mock.
 *
 * Asset: USDC on Ronin Saigon (6 decimals). Protocol: x402-v1.
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
  RONIN_SAIGON_CHAIN_ID,
  RONIN_SAIGON_USDC,
  roninSaigonChain,
  toRoninDisplay,
  txExplorerUrl,
} from "./chain.js";
import {
  RoninTokenClient,
  createWalletClientFromPrivateKey,
  generateNonce,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./token-client.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "ronin" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const RONIN_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

/** CAIP-2 chain id for Ronin Saigon. */
const CAIP2_CHAIN = `eip155:${RONIN_SAIGON_CHAIN_ID}`;

/**
 * Offline-default EIP-712 domain name for the USDC token. Used when no live
 * RPC `name()` read is available (conformance runs fully offline). On LIVE
 * runs the real on-chain name is read and cached. "USD Coin" matches Circle's
 * canonical USDC name; override via config if the deployment differs.
 */
const DEFAULT_TOKEN_NAME = "USD Coin" as const;

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
//  Broadcaster (pluggable settlement transport)
// ============================================================================

/**
 * Pluggable broadcast transport. The default is an offline deterministic mock
 * so settle() works without network. Production / LIVE wires the real on-chain
 * broadcaster via {@link makeOnChainBroadcaster}.
 */
export interface Broadcaster {
  broadcast(
    signed: Eip3009SignedAuthorization
  ): Promise<{ txHash: Hex; blockNumber?: bigint; gasUsed?: bigint }>;
}

/** Offline deterministic mock broadcaster (default). Never touches network. */
export class MockBroadcaster implements Broadcaster {
  async broadcast(
    signed: Eip3009SignedAuthorization
  ): Promise<{ txHash: Hex; blockNumber?: bigint; gasUsed?: bigint }> {
    // Deterministic pseudo-hash derived from the real signature (32 bytes).
    const sig = signed.signature.slice(2).padEnd(64, "0").slice(0, 64);
    return { txHash: `0x${sig}` as Hex };
  }
}

// ============================================================================
//  Configuration
// ============================================================================

export interface RoninSaigonConnectorConfig {
  /**
   * The agent's private key (Hex, 0x-prefixed). In production load from AWS
   * Secrets Manager. If omitted, a fresh keypair is generated in-process.
   */
  readonly privateKey?: Hex;
  /** Token contract address. Default: USDC on Ronin Saigon. */
  readonly tokenAddress?: Address;
  /** Chain to operate on. Default: Ronin Saigon. */
  readonly chain?: Chain;
  /** RPC override (e.g. private node). */
  readonly rpcUrl?: string;
  /** Storage adapter for (userId → Instrument) bindings. */
  readonly instrumentStore: InstrumentStore;
  /** Optional separate facilitator wallet for on-chain broadcast (gas-payer). */
  readonly facilitatorPrivateKey?: Hex;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
  /** Optional override for token client (for testing / offline). */
  readonly tokenClient?: RoninTokenClient;
  /**
   * Optional broadcast transport. Default: {@link MockBroadcaster} (offline).
   * Pass {@link makeOnChainBroadcaster} output to settle on real Ronin Saigon.
   */
  readonly broadcaster?: Broadcaster;
  /**
   * EIP-712 domain name for the token. Default "USD Coin". Used offline; on
   * LIVE runs the on-chain `name()` overrides this when available.
   */
  readonly tokenName?: string;
}

// ============================================================================
//  Connector
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDC", decimals: 6, chain: CAIP2_CHAIN, contract: RONIN_SAIGON_USDC },
];

export class RoninSaigonConnector implements WalletConnector {
  private readonly tokenClient: RoninTokenClient;
  private readonly agentAccount: PrivateKeyAccount;
  private readonly facilitatorAccount: PrivateKeyAccount;
  private readonly facilitatorWallet: WalletClient | undefined;
  private readonly store: InstrumentStore;
  private readonly chain: Chain;
  private readonly now: () => number;
  private readonly broadcaster: Broadcaster;
  private readonly configuredTokenName: string;
  /** Cached EIP-712 domain name (resolved lazily, offline-safe). */
  private cachedTokenName: string | undefined;

  constructor(config: RoninSaigonConnectorConfig) {
    this.chain = config.chain ?? roninSaigonChain;
    this.now = config.now ?? Date.now;
    this.store = config.instrumentStore;
    this.broadcaster = config.broadcaster ?? new MockBroadcaster();
    this.configuredTokenName = config.tokenName ?? DEFAULT_TOKEN_NAME;

    const tokenAddress = config.tokenAddress ?? RONIN_SAIGON_USDC;

    // Agent wallet (signer of EIP-712 transferWithAuthorization).
    // Generate a fresh EVM keypair in-process when no key is supplied.
    const agentKey = config.privateKey ?? generatePrivateKey();
    const agent = createWalletClientFromPrivateKey(
      agentKey,
      this.chain,
      config.rpcUrl
    );
    this.agentAccount = agent.account;

    // Facilitator wallet (broadcaster — pays gas). Only built when a real
    // on-chain broadcaster is in play; the mock path needs no wallet.
    if (config.facilitatorPrivateKey) {
      const fac = createWalletClientFromPrivateKey(
        config.facilitatorPrivateKey,
        this.chain,
        config.rpcUrl
      );
      this.facilitatorWallet = fac.wallet;
      this.facilitatorAccount = fac.account;
    } else {
      this.facilitatorWallet = agent.wallet;
      this.facilitatorAccount = agent.account;
    }

    this.tokenClient =
      config.tokenClient ??
      new RoninTokenClient({
        tokenAddress,
        chain: this.chain,
        ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Ronin Saigon (Self-Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [RONIN_PROTOCOL],
      requiresUserApproval: false, // key in Secrets Manager → no UI prompt
      settlesOnChain: true,
      typicalLatencyMs: 3000, // ~3s block time on Ronin
      features: {
        gasInNativeToken: true, // RON pays gas
        instantFinality: false,
        sandboxAvailable: true,
        evmSidechain: true,
        roninAddressPrefix: true,
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

    const id = `payment-instrument-ronin-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.agentAccount.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        chainId: this.chain.id,
        tokenAddress: this.tokenClient.tokenAddress,
        roninAddress: toRoninDisplay(this.agentAccount.address),
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
   * Sign an EIP-3009 transferWithAuthorization. Produces an x402-compatible
   * SignedAuthorization. Does NOT broadcast. Self-verifies the signature via
   * off-chain ecrecover before returning (defence in depth).
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== RONIN_PROTOCOL) {
      throw new Error(
        `RoninSaigonConnector only supports protocol ${RONIN_PROTOCOL}, got ${input.request.protocol}`
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

    const domainName = await this.resolveTokenName();
    const signed = await this.tokenClient.signTransferAuthorization(
      this.agentAccount,
      authorization,
      domainName
    );

    // Defence in depth: prove the signature recovers to the agent before we
    // hand it off. A bug here would otherwise only surface at settle().
    const ok = await RoninTokenClient.verifySignedAuthorization(signed);
    if (!ok) {
      throw new Error(
        "signAuthorization: self-verification failed — recovered signer does not match agent"
      );
    }

    return {
      request: input.request,
      signer: this.agentAccount.address,
      signature: signed.signature,
      extra: {
        signed,
        chainId: this.chain.id,
        verifyingContract: this.tokenClient.tokenAddress,
        roninSigner: toRoninDisplay(this.agentAccount.address),
      },
    };
  }

  /**
   * Broadcast the signed authorization. Uses the pluggable {@link Broadcaster}
   * (offline mock by default; on-chain when {@link makeOnChainBroadcaster} is
   * wired). Returns SettlementResult with tx hash + explorer link in `raw`.
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
    // Re-verify off-chain before spending gas.
    const ok = await RoninTokenClient.verifySignedAuthorization(wireSigned);
    if (!ok) {
      return {
        success: false,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Signature failed off-chain verification (ecrecover mismatch)",
      };
    }
    try {
      const { txHash, blockNumber, gasUsed } =
        await this.broadcaster.broadcast(wireSigned);
      return {
        success: true,
        transactionRef: txHash as TransactionRef,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          ...(blockNumber !== undefined ? { blockNumber: blockNumber.toString() } : {}),
          ...(gasUsed !== undefined ? { gasUsed: gasUsed.toString() } : {}),
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

  /** Cosmetic Ronin-prefixed display form of the agent address. */
  get roninDisplayAddress(): string {
    return toRoninDisplay(this.agentAccount.address);
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

  /** Build an on-chain broadcaster bound to this connector's facilitator wallet. */
  makeOnChainBroadcaster(): Broadcaster {
    const wallet = this.facilitatorWallet;
    const tokenClient = this.tokenClient;
    if (!wallet) {
      throw new Error("No facilitator wallet configured for on-chain broadcast");
    }
    return {
      async broadcast(signed: Eip3009SignedAuthorization) {
        const txHash = await tokenClient.broadcastSignedAuthorization(
          wallet,
          signed
        );
        const receipt = await tokenClient.waitForReceipt(txHash);
        if (receipt.status !== "success") {
          throw new Error(`Tx reverted at block ${receipt.blockNumber}`);
        }
        return {
          txHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
        };
      },
    };
  }

  // ---- Internals ---------------------------------------------------------

  private async resolveTokenName(): Promise<string> {
    if (this.cachedTokenName !== undefined) return this.cachedTokenName;
    // Offline-safe: fall back to the configured name if the RPC read fails.
    try {
      const name = await this.tokenClient.getName();
      this.cachedTokenName = name;
      return name;
    } catch {
      this.cachedTokenName = this.configuredTokenName;
      return this.configuredTokenName;
    }
  }

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
export { RONIN_SAIGON_CHAIN_ID };

// Avoid Money-related lint warnings about unused symbol via re-export
export type { Money };
