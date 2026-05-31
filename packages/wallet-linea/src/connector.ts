/**
 * LineaConnector — implements WalletConnector for self-custodial EVM wallets
 * on Linea Sepolia (zkEVM L2, chainId 59141).
 *
 * Self-custodial model (mirrors wallet-hashkey):
 *   - The agent holds the EOA private key (AWS Secrets Manager in prod).
 *   - signAuthorization() produces an off-chain EIP-712 EIP-3009
 *     transferWithAuthorization signature (no chain I/O).
 *   - settle() broadcasts the signed authorization through a facilitator
 *     wallet (defaults to a pluggable, offline-safe mock broadcaster).
 *
 * When no private key is supplied, a fresh EVM keypair is generated in-process
 * via viem `generatePrivateKey` — handy for demos/tests.
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
  type Hex,
  bytesToHex,
  parseSignature,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";

import {
  lineaSepoliaTestnet,
  LINEA_SEPOLIA_USDC,
  txExplorerUrl,
} from "./chain.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "linea" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const LINEA_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

/** EIP-712 typed-data schema for TransferWithAuthorization (USDC-shaped). */
export const EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "USDC", decimals: 6 }];

// ============================================================================
//  Wire types
// ============================================================================

export interface Eip3009Authorization {
  readonly from: Address;
  readonly to: Address;
  /** Atomic units, stringified for JSON safety. */
  readonly value: string;
  readonly validAfter: number;
  readonly validBefore: number;
  /** 32-byte hex with 0x prefix. */
  readonly nonce: Hex;
}

export interface Eip3009SignedAuthorization {
  readonly authorization: Eip3009Authorization;
  readonly signature: Hex;
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

// ============================================================================
//  TokenClient — the pluggable, offline-safe signing/balance/broadcast surface
// ============================================================================

/**
 * Stubbable token client. The default implementation performs REAL EIP-712
 * signing (no network) but uses a mock balance + a mock broadcast tx hash so
 * the connector is fully offline-safe. Tests inject a stub via
 * {@link LineaConnectorConfig.tokenClient}; the conformance suite uses the
 * default (real signing).
 */
export interface LineaTokenClient {
  readonly tokenAddress: Address;
  readonly chain: typeof lineaSepoliaTestnet;
  getDecimals(): Promise<number>;
  getName(): Promise<string>;
  getBalance(owner: Address): Promise<bigint>;
  signTransferAuthorization(
    signer: PrivateKeyAccount,
    authorization: Eip3009Authorization
  ): Promise<Eip3009SignedAuthorization>;
  broadcastSignedAuthorization(
    signed: Eip3009SignedAuthorization
  ): Promise<Hex>;
  waitForReceipt(
    txHash: Hex
  ): Promise<{ blockNumber: bigint; gasUsed: bigint; status: "success" | "reverted" }>;
}

/**
 * Default offline-safe token client. Real EIP-712 signing; mock RPC reads and
 * mock broadcast (deterministic tx hash). Suitable for demos + conformance.
 */
export class DefaultLineaTokenClient implements LineaTokenClient {
  public readonly tokenAddress: Address;
  public readonly chain: typeof lineaSepoliaTestnet;
  private readonly mockBalance: bigint;

  constructor(opts: {
    tokenAddress: Address;
    chain?: typeof lineaSepoliaTestnet;
    mockBalance?: bigint;
  }) {
    this.tokenAddress = opts.tokenAddress;
    this.chain = opts.chain ?? lineaSepoliaTestnet;
    this.mockBalance = opts.mockBalance ?? 1_000_000_000n; // 1000 USDC
  }

  async getDecimals(): Promise<number> {
    return 6;
  }

  async getName(): Promise<string> {
    return "USD Coin";
  }

  async getBalance(_owner: Address): Promise<bigint> {
    return this.mockBalance;
  }

  async signTransferAuthorization(
    signer: PrivateKeyAccount,
    authorization: Eip3009Authorization
  ): Promise<Eip3009SignedAuthorization> {
    if (signer.address.toLowerCase() !== authorization.from.toLowerCase()) {
      throw new Error(
        `Signer address ${signer.address} does not match authorization.from ${authorization.from}`
      );
    }
    const name = await this.getName();
    const signature = await signer.signTypedData({
      domain: {
        name,
        version: "2",
        chainId: BigInt(this.chain.id),
        verifyingContract: this.tokenAddress,
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
    });
    const { v, r, s } = parseSignature(signature);
    if (v === undefined) {
      throw new Error(
        "parseSignature did not return v — should not happen for legacy signatures"
      );
    }
    return {
      authorization,
      signature,
      v: Number(v),
      r,
      s,
      chainId: this.chain.id,
      verifyingContract: this.tokenAddress,
    };
  }

  async broadcastSignedAuthorization(
    signed: Eip3009SignedAuthorization
  ): Promise<Hex> {
    if (signed.chainId !== this.chain.id) {
      throw new Error(
        `Signed authorization chainId ${signed.chainId} does not match client chainId ${this.chain.id}`
      );
    }
    // Offline-safe deterministic mock tx hash (derived from the signature).
    return `0x${signed.signature.slice(2, 66).padEnd(64, "0")}` as Hex;
  }

  async waitForReceipt(
    _txHash: Hex
  ): Promise<{ blockNumber: bigint; gasUsed: bigint; status: "success" | "reverted" }> {
    return { blockNumber: 1n, gasUsed: 82_406n, status: "success" };
  }
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
//  Configuration
// ============================================================================

export interface LineaConnectorConfig {
  /**
   * The agent's private key (Hex, 0x-prefixed). In production load from AWS
   * Secrets Manager. If omitted, a fresh keypair is generated in-process.
   */
  readonly privateKey?: Hex;
  /** Token contract address. Default: Circle USDC on Linea Sepolia. */
  readonly tokenAddress?: Address;
  /** Chain to operate on. Default: Linea Sepolia Testnet. */
  readonly chain?: typeof lineaSepoliaTestnet;
  /** Storage adapter for (userId → Instrument) bindings. */
  readonly instrumentStore: InstrumentStore;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
  /** Optional override for token client (for testing). */
  readonly tokenClient?: LineaTokenClient;
}

// ============================================================================
//  Connector
// ============================================================================

export class LineaConnector implements WalletConnector {
  private readonly tokenClient: LineaTokenClient;
  private readonly agentAccount: PrivateKeyAccount;
  private readonly store: InstrumentStore;
  private readonly chain: typeof lineaSepoliaTestnet;
  private readonly now: () => number;

  constructor(config: LineaConnectorConfig) {
    this.chain = config.chain ?? lineaSepoliaTestnet;
    this.now = config.now ?? Date.now;
    this.store = config.instrumentStore;

    const privateKey = config.privateKey ?? generatePrivateKey();
    this.agentAccount = privateKeyToAccount(privateKey);

    const tokenAddress =
      config.tokenAddress ?? (LINEA_SEPOLIA_USDC as Address);
    this.tokenClient =
      config.tokenClient ??
      new DefaultLineaTokenClient({ tokenAddress, chain: this.chain });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Linea (Self-Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [LINEA_PROTOCOL],
      requiresUserApproval: false,
      settlesOnChain: true,
      typicalLatencyMs: 3000, // Linea ~2-3s block time
      features: {
        gasInNativeToken: true,
        instantFinality: false,
        sandboxAvailable: true,
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

    const id = `payment-instrument-linea-${input.userId}` as InstrumentId;
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
      asset: { symbol: "USDC", decimals },
      money: {
        amountAtomic: balanceWei.toString(),
        decimals,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== LINEA_PROTOCOL) {
      throw new Error(
        `LineaConnector only supports protocol ${LINEA_PROTOCOL}, got ${input.request.protocol}`
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

  generateNonce(): Hex {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
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
  if (v.length < 66) {
    v = "0x" + v.slice(2).padStart(64, "0");
  } else if (v.length > 66) {
    v = "0x" + v.slice(2).slice(0, 64);
  }
  return v as Hex;
}

// Re-export Money to keep the type referenced in public signatures.
export type { Money };
