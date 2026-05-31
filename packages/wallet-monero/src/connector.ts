/**
 * Monero Wallet Connector
 * ========================
 *
 * A WalletConnector for Monero (XMR) — a privacy chain with a fundamentally
 * different account model than EVM/Solana:
 *
 *   - Identity: TWO Ed25519 keypairs (spend + view), not one.
 *   - Visibility: the VIEW key is shareable and grants read-only sight of
 *     incoming funds; the SPEND key authorizes outflows. We store the view
 *     secret in `providerMetadata` (NEVER the spend secret).
 *   - Settlement: real Monero spends use ring signatures + RingCT + stealth
 *     addresses (OUT OF SCOPE — this is the identity + authorization layer).
 *
 * Despite all that, Monero still satisfies the same 5-method WalletConnector
 * contract. signAuthorization() produces a REAL, verifiable Ed25519 signature
 * with the spend key; settle() adapts it (broadcast is pluggable + offline-safe).
 *
 * Protocol: "monero-pay-v1" — a minimal monero: URI / 402-envelope scheme,
 *   modeled on the BIP-21-ish `monero:<address>?tx_amount=...&tx_payment_id=...`
 *   URIs that real Monero wallets emit.
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type PaymentRequest,
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
  RealMoneroSigner,
  canonicalTransferDescriptor,
  isValidMoneroAddress,
  type MoneroNetwork,
} from "./real-signer.js";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "monero-pay-v1" as ProtocolId;
export const WALLET_PROVIDER_ID = "monero" as WalletProviderId;
export const X_PAYMENT_MONERO_HEADER = "X-PAYMENT-MONERO";

/** XMR has 12 decimal places (1 XMR = 1e12 piconero / "atomic units"). */
export const XMR_DECIMALS = 12;

// ============================================================================
//  Monero signer abstraction (pluggable)
// ============================================================================

export interface MoneroSigner {
  /** base58 Monero address (packs spend + view public keys). */
  readonly address: string;
  /** Public view key (hex) — shareable. */
  readonly viewPubHex: string;
  /** Secret view key (hex) — shareable read-only key (NOT the spend key). */
  readonly viewSecretHex: string;
  /** Network the address belongs to. */
  readonly network: MoneroNetwork;
  /**
   * Sign + (optionally) submit a Monero transfer. Implementations:
   *   - RealMoneroSigner (real Ed25519 spend-key signature, pluggable submit)
   *   - wallet-rpc backed signer (production daemon broadcast)
   */
  signAndSubmit(input: {
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly paymentId?: string;
    readonly memo?: string;
  }): Promise<{
    readonly signatureHex: string;
    readonly txHash?: string;
    readonly explorerUrl?: string;
  }>;
  getBalance(): Promise<bigint>;
}

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

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "XMR", decimals: XMR_DECIMALS }];

export interface MoneroConnectorConfig {
  readonly signer: MoneroSigner;
  readonly instrumentStore: InstrumentStore;
  /** Override clock for tests. */
  readonly now?: () => number;
}

export class MoneroConnector implements WalletConnector {
  private readonly signer: MoneroSigner;
  private readonly store: InstrumentStore;
  private readonly now: () => number;

  constructor(cfg: MoneroConnectorConfig) {
    this.signer = cfg.signer;
    this.store = cfg.instrumentStore;
    this.now = cfg.now ?? Date.now;
  }

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `Monero (${this.signer.network})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_ID],
      requiresUserApproval: false, // server-side spend-key signer
      settlesOnChain: true,
      typicalLatencyMs: 120_000, // ~2 min block time on Monero
      features: {
        nonEvm: true,
        privacyChain: true,
        ed25519: true,
        viewKeyModel: true,
        ringSignatures: "out-of-scope (identity+auth layer only)",
        network: this.signer.network,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) {
      throw new Error("createInstrument: userId is required");
    }
    const existing = await this.store.get(input.userId);
    if (existing) return existing;
    const id = `payment-instrument-monero-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.signer.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        network: this.signer.network,
        // The VIEW key is intentionally surfaced — it grants read-only
        // incoming-funds visibility (the whole point of Monero's view-key
        // model) WITHOUT exposing the spend key.
        viewPublicKeyHex: this.signer.viewPubHex,
        viewSecretKeyHex: this.signer.viewSecretHex,
        // SPEND secret is NEVER stored here.
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const atomic = await this.signer.getBalance();
    return {
      instrumentId: inst.id,
      asset: { symbol: "XMR", decimals: XMR_DECIMALS },
      money: {
        amountAtomic: atomic.toString(),
        decimals: XMR_DECIMALS,
        currency: "XMR",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== PROTOCOL_ID) {
      throw new Error(
        `MoneroConnector only supports ${PROTOCOL_ID}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== this.signer.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match signer ${this.signer.address}`
      );
    }
    if (!isValidMoneroAddress(input.request.recipient)) {
      throw new Error(
        `Recipient is not a valid Monero address: ${input.request.recipient}`
      );
    }
    const paymentId = input.request.nonce;
    const result = await this.signer.signAndSubmit({
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      paymentId,
      ...(input.request.description !== undefined
        ? { memo: input.request.description }
        : {}),
    });
    return {
      request: input.request,
      signer: this.signer.address,
      signature: result.signatureHex,
      extra: {
        network: this.signer.network,
        ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
        explorerUrl: result.explorerUrl ?? "",
        // The canonical descriptor that was signed — lets the merchant /
        // facilitator re-derive + verify the Ed25519 signature offline.
        descriptor: canonicalTransferDescriptor({
          network: this.signer.network,
          from: this.signer.address,
          to: input.request.recipient,
          amountAtomic: input.request.amount.amountAtomic,
          paymentId,
          ...(input.request.description !== undefined
            ? { memo: input.request.description }
            : {}),
        }),
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    if (!signed.signature) {
      return {
        success: false,
        network: `monero-${this.signer.network}`,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing signature",
      };
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    // txHash present → real broadcast happened; else the signature itself is
    // the deterministic offline reference (broadcast deferred to production).
    const txRef = (e["txHash"] as string | undefined) ?? signed.signature;
    return {
      success: true,
      transactionRef: txRef as TransactionRef,
      network: `monero-${this.signer.network}`,
      settledAt: nowIso(this.now()),
      settledAmount: signed.request.amount,
      raw: {
        explorerUrl: e["explorerUrl"],
        signatureHex: signed.signature,
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
//  monero: URI parsing (monero-pay-v1)
// ============================================================================

export interface MoneroUriFields {
  readonly recipient: string;
  readonly amount?: string; // decimal XMR string, e.g., "0.5"
  readonly paymentId?: string;
  readonly description?: string;
  readonly recipientName?: string;
}

const MONERO_SCHEME = "monero:";

/**
 * Parse a `monero:<address>?tx_amount=...&tx_payment_id=...&tx_description=...`
 * URI. Throws on malformed input or invalid address checksum.
 */
export function parseMoneroUri(uri: string): MoneroUriFields {
  if (typeof uri !== "string" || !uri.startsWith(MONERO_SCHEME)) {
    throw new Error(`Monero URI must start with "${MONERO_SCHEME}"`);
  }
  const afterScheme = uri.slice(MONERO_SCHEME.length);
  const queryIdx = afterScheme.indexOf("?");
  const recipient = queryIdx >= 0 ? afterScheme.slice(0, queryIdx) : afterScheme;
  if (!recipient) {
    throw new Error("Monero URI missing recipient address");
  }
  if (!isValidMoneroAddress(recipient)) {
    throw new Error(`Monero URI recipient is not a valid address: ${recipient}`);
  }
  const fields: {
    -readonly [K in keyof MoneroUriFields]: MoneroUriFields[K];
  } = { recipient };
  if (queryIdx < 0) return fields;
  const params = new URLSearchParams(afterScheme.slice(queryIdx + 1));
  for (const [k, v] of params.entries()) {
    switch (k) {
      case "tx_amount":
        fields.amount = v;
        break;
      case "tx_payment_id":
        fields.paymentId = v;
        break;
      case "tx_description":
        fields.description = v;
        break;
      case "recipient_name":
        fields.recipientName = v;
        break;
      default:
        break;
    }
  }
  return fields;
}

/** Build a monero: URI from fields. Inverse of `parseMoneroUri`. */
export function buildMoneroUri(fields: MoneroUriFields): string {
  const params: string[] = [];
  if (fields.amount) params.push(`tx_amount=${encodeURIComponent(fields.amount)}`);
  if (fields.paymentId)
    params.push(`tx_payment_id=${encodeURIComponent(fields.paymentId)}`);
  if (fields.description)
    params.push(`tx_description=${encodeURIComponent(fields.description)}`);
  if (fields.recipientName)
    params.push(`recipient_name=${encodeURIComponent(fields.recipientName)}`);
  return `${MONERO_SCHEME}${fields.recipient}${
    params.length ? "?" + params.join("&") : ""
  }`;
}

/** Convert a decimal XMR string like "0.5" → piconero atomic string "500000000000". */
export function xmrToAtomic(decimal: string): string {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new Error(`Invalid XMR decimal amount: ${decimal}`);
  }
  const [whole = "0", frac = ""] = decimal.split(".");
  const fracPadded = (frac + "0".repeat(XMR_DECIMALS)).slice(0, XMR_DECIMALS);
  const combined = (whole + fracPadded).replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

// ============================================================================
//  Convenience factory
// ============================================================================

/** Build a MoneroConnector with a fresh RealMoneroSigner + in-memory store. */
export function createMoneroConnector(
  opts: { network?: MoneroNetwork; signer?: MoneroSigner } = {}
): MoneroConnector {
  return new MoneroConnector({
    signer:
      opts.signer ??
      new RealMoneroSigner(opts.network ? { network: opts.network } : {}),
    instrumentStore: new MemoryInstrumentStore(),
  });
}

// ============================================================================
//  Helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}
