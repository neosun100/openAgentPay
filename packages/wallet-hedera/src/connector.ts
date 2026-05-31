/**
 * Hedera Wallet Connector
 * ========================
 *
 * Implements the 5-method WalletConnector contract for Hedera Hashgraph,
 * proving the abstraction holds for yet another non-EVM chain model:
 *
 *   - Crypto: Ed25519 (native Hedera key type, via @noble/curves)
 *   - Identity: "0.0.<num>" account id (network-assigned; offline we derive a
 *     deterministic mock from the pubkey)
 *   - Assets: native HBAR (8 decimals) + HTS token USDC (6 decimals,
 *     token id 0.0.456858 on mainnet)
 *   - Settlement: TransferTransaction → consensus node (deferred behind a
 *     pluggable `submit` hook; offline-safe by default)
 *
 * Protocol: "hedera-hcs-v1" — a Hedera-flavored transfer-authorization scheme.
 * The connector signs a canonical transfer descriptor with Ed25519.
 *
 * Implementation strategy: PURE TypeScript, no @hashgraph/sdk. Real signing
 * runs through RealHederaSigner; on-network broadcast is wired via the signer's
 * optional `submit` hook in production.
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
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
  RealHederaSigner,
  canonicalTransferDescriptor,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "hedera-hcs-v1";
export const WALLET_PROVIDER_ID = "hedera" as WalletProviderId;

/** HTS USDC token id (Hedera mainnet). */
export const HTS_USDC_TOKEN_ID = "0.0.456858";

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "HBAR", decimals: 8 },
  { symbol: "USDC", decimals: 6, contract: HTS_USDC_TOKEN_ID },
];

// ============================================================================
//  InstrumentStore
// ============================================================================

export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(id: InstrumentId): Promise<Instrument | undefined>;
}

export class MemoryInstrumentStore implements InstrumentStore {
  private byUser = new Map<string, Instrument>();
  private byId = new Map<string, Instrument>();
  async get(userId: UserId) {
    return this.byUser.get(userId);
  }
  async put(instrument: Instrument) {
    this.byUser.set(instrument.userId, instrument);
    this.byId.set(instrument.id, instrument);
  }
  async getById(id: InstrumentId) {
    return this.byId.get(id);
  }
}

// ============================================================================
//  WalletConnector
// ============================================================================

export interface HederaConnectorConfig {
  readonly signer: RealHederaSigner;
  readonly instrumentStore: InstrumentStore;
  readonly network?: "mainnet" | "testnet" | "previewnet";
  /** Default HTS token id used for balance reads + USDC transfers. */
  readonly defaultTokenId?: string;
  readonly now?: () => number;
}

export class HederaConnector implements WalletConnector {
  private readonly signer: RealHederaSigner;
  private readonly store: InstrumentStore;
  private readonly network: "mainnet" | "testnet" | "previewnet";
  private readonly defaultTokenId: string;
  private readonly now: () => number;

  constructor(cfg: HederaConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.network = cfg.network ?? "testnet";
    this.defaultTokenId = cfg.defaultTokenId ?? HTS_USDC_TOKEN_ID;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Hedera (${this.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID as unknown as WalletCapabilities["supportedProtocols"][number]],
      requiresUserApproval: false, // server-side Ed25519 signer
      settlesOnChain: true,
      typicalLatencyMs: 3000, // Hedera finality ~3–5s
      features: {
        nonEvm: true,
        ed25519: true,
        nativeHbar: true,
        htsToken: true,
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
    const id = `payment-instrument-hedera-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.accountId, // "0.0.<num>"
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.network,
        defaultTokenId: this.defaultTokenId,
        publicKeyHex: this.signer.publicKeyHex,
        keyType: "ed25519",
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance(this.defaultTokenId);
    return {
      instrumentId: inst.id,
      asset: { symbol: "USDC", decimals: 6, contract: this.defaultTokenId },
      money: {
        amountAtomic: atomic.toString(),
        decimals: 6,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if ((input.request.protocol as unknown as string) !== PROTOCOL_ID) {
      throw new Error(
        `HederaConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.accountId) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.accountId}`
      );
    }
    // Native HBAR transfers carry no token id; HTS transfers do.
    const tokenId =
      input.request.asset.contract ??
      (input.request.asset.symbol === "HBAR" ? undefined : this.defaultTokenId);

    const result = await this.signer.signAndSubmit({
      to: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      ...(tokenId !== undefined ? { tokenId } : {}),
      nonce: input.request.nonce,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });

    return {
      request: input.request,
      signer: this.signer.accountId,
      signature: result.signatureHex,
      extra: {
        publicKeyHex: this.signer.publicKeyHex,
        consensusTxId: result.consensusTxId ?? "",
        explorerUrl: result.explorerUrl ?? "",
        network: this.network,
        ...(tokenId !== undefined ? { tokenId } : {}),
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    // signAuthorization already produced the real Ed25519 signature and (in
    // production, via the submit hook) broadcast the TransferTransaction.
    // settle() adapts that into a SettlementResult.
    if (!signed.signature) {
      return {
        success: false,
        network: `hedera-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing Ed25519 signature",
      };
    }
    // Defensive: verify the signature actually authorizes this request.
    const descriptor = canonicalTransferDescriptor({
      from: signed.signer,
      to: signed.request.recipient,
      amountAtomic: signed.request.amount.amountAtomic,
      ...(signed.request.asset.contract !== undefined
        ? { tokenId: signed.request.asset.contract }
        : signed.request.asset.symbol === "HBAR"
          ? {}
          : { tokenId: this.defaultTokenId }),
      ...(signed.request.description !== undefined
        ? { memo: signed.request.description }
        : {}),
      nonce: signed.request.nonce,
    });
    if (!this.signer.verify(signed.signature, descriptor)) {
      return {
        success: false,
        network: `hedera-${this.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Ed25519 signature failed verification",
      };
    }

    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const txRef = (typeof e["consensusTxId"] === "string" && e["consensusTxId"]
      ? e["consensusTxId"]
      : signed.signature) as TransactionRef;
    return {
      success: true,
      transactionRef: txRef,
      network: `hedera-${this.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        consensusTxId: e["consensusTxId"],
        explorerUrl: e["explorerUrl"],
        publicKeyHex: e["publicKeyHex"],
      },
    };
  }

  // ---- Helpers -------------------------------------------------------------

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
