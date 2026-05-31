/**
 * PaymentManager — top-level orchestrator
 * ==========================================
 *
 * Mirrors **AWS Bedrock AgentCore PaymentManager** as the top-level resource
 * that coordinates payment operations:
 *
 *   1. createPaymentSession   — mint a session with budget + TTL
 *   2. createPaymentInstrument — bind a user to a wallet provider
 *   3. processPayment         — execute the full 12-step x402 / OAP-CEX flow
 *
 * Internally composes:
 *   - SessionManager (DDB or in-memory)
 *   - Connector Registry (multiple WalletConnectors by walletProvider)
 *
 * Design principle: **interface alignment with AgentCore Payments** so that
 * a customer using `AgentCorePaymentsPlugin` can drop in `OpenAgentPayPlugin`
 * with only an import change.
 *
 * @license Apache-2.0
 */

import {
  type CreateInstrumentInput,
  type CreateSessionInput,
  type Instrument,
  type InstrumentId,
  type Money,
  type PaymentRequest,
  type Session,
  type SessionId,
  type SettlementResult,
  type SignedAuthorization,
  type TransactionRef,
  type UserId,
  type WalletConnector,
  type WalletProviderId,
} from "../types.js";
import {
  InMemorySessionManager,
  type SessionManager,
} from "../session/manager.js";
import type {
  RefundExecutor,
  RefundRequest,
  RefundResult,
} from "../finance/types.js";

// ============================================================================
//  Public API surface
// ============================================================================

/**
 * Input to {@link PaymentManager.processPayment}. All required fields:
 *   - sessionId:    the active payment session
 *   - instrumentId: which wallet to pay from
 *   - request:      what to pay (amount, recipient, asset, protocol)
 */
export interface ProcessPaymentInput {
  readonly sessionId: SessionId;
  readonly instrumentId: InstrumentId;
  readonly request: PaymentRequest;
}

/**
 * Output of {@link PaymentManager.processPayment} — wraps the upstream
 * SettlementResult plus session-level state.
 */
export interface ProcessPaymentOutput {
  readonly success: boolean;
  readonly settlement: SettlementResult;
  readonly signed?: SignedAuthorization;
  readonly sessionAfter: Session;
}

/**
 * Top-level orchestrator interface. Implementations:
 *   - InMemoryPaymentManager (this file)
 *   - DynamoDBPaymentManager  (future, in cdk-deploy)
 *   - LambdaPaymentManagerClient (calls a remote Lambda; future)
 */
export interface PaymentManager {
  // ---- Resource creation (mirrors AgentCore Payments names) -----------------

  /** Mint a new session with budget cap + TTL. */
  createPaymentSession(input: CreateSessionInput): Promise<Session>;

  /** Bind a user to a wallet provider. Idempotent. */
  createPaymentInstrument(
    walletProvider: WalletProviderId,
    input: CreateInstrumentInput
  ): Promise<Instrument>;

  /** Read a session by id. */
  getPaymentSession(id: SessionId): Promise<Session | undefined>;

  // ---- Core data plane API -------------------------------------------------

  /**
   * The full 12-step x402 / OAP-CEX flow in one call:
   *   1. validate session + instrument
   *   2. checkAndReserve session budget
   *   3. signAuthorization via connector
   *   4. settle via connector
   *   5. commit/release session reservation
   *   6. return structured result
   *
   * Mirrors AgentCore Payments `ProcessPayment` API.
   */
  processPayment(input: ProcessPaymentInput): Promise<ProcessPaymentOutput>;

  /**
   * Refund a prior settled payment. Validates against an in-memory ledger of
   * settled payments (populated by {@link PaymentManager.processPayment}):
   *   - original_not_found   if the originalTransactionRef is unknown
   *   - exceeds_original     if amount + already-refunded > original amount
   *   - already_refunded     if the same idempotencyKey was seen before
   *   - not_supported        if no RefundExecutor is wired
   *   - else delegates to the configured RefundExecutor.
   */
  refund(req: RefundRequest): Promise<RefundResult>;

  // ---- Connector registry (OpenAgentPay extension) -------------------------

  /** Register a wallet connector. Multiple connectors keyed by walletProvider. */
  registerConnector(connector: WalletConnector): void;

  /** Look up a connector by walletProvider. */
  getConnector(provider: WalletProviderId): WalletConnector | undefined;

  /** List all registered providers. */
  listProviders(): readonly WalletProviderId[];
}

// ============================================================================
//  Errors
// ============================================================================

export class PaymentManagerError extends Error {
  override readonly name = "PaymentManagerError";
  constructor(
    message: string,
    public readonly code:
      | "session_not_found"
      | "instrument_not_found"
      | "connector_not_registered"
      | "session_rejected"
      | "settlement_failed"
      | "internal"
  ) {
    super(message);
  }
}

// ============================================================================
//  In-memory implementation (for tests + local dev + single-Lambda use)
// ============================================================================

export interface InMemoryPaymentManagerConfig {
  /** Custom SessionManager (default: InMemorySessionManager). */
  readonly sessionManager?: SessionManager;
  /** Function to look up an Instrument by id. */
  readonly resolveInstrument: (id: InstrumentId) => Promise<Instrument | undefined>;
  /** Optional pluggable refund backend. If absent, refund() returns not_supported. */
  readonly refundExecutor?: RefundExecutor;
}

/**
 * In-memory PaymentManager — useful for tests, single-Lambda deployments, and
 * local demos. Production should use DynamoDBPaymentManager.
 */
export class InMemoryPaymentManager implements PaymentManager {
  private readonly connectors = new Map<string, WalletConnector>();
  private readonly sessionManager: SessionManager;
  private readonly resolveInstrument: (id: InstrumentId) => Promise<Instrument | undefined>;
  private readonly refundExecutor: RefundExecutor | undefined;
  /** transactionRef → settled-payment ledger entry (for refund validation). */
  private readonly settlementLedger = new Map<string, SettlementLedgerEntry>();
  /** scoped idempotencyKey → prior RefundResult (idempotent refunds). */
  private readonly refundIdempotency = new Map<string, RefundResult>();

  constructor(config: InMemoryPaymentManagerConfig) {
    this.sessionManager = config.sessionManager ?? new InMemorySessionManager();
    this.resolveInstrument = config.resolveInstrument;
    this.refundExecutor = config.refundExecutor;
  }

  // ---- Resource creation ----------------------------------------------------

  async createPaymentSession(input: CreateSessionInput): Promise<Session> {
    return this.sessionManager.createSession(input);
  }

  async createPaymentInstrument(
    walletProvider: WalletProviderId,
    input: CreateInstrumentInput
  ): Promise<Instrument> {
    const connector = this.connectors.get(walletProvider);
    if (!connector) {
      throw new PaymentManagerError(
        `No connector registered for wallet provider: ${walletProvider}`,
        "connector_not_registered"
      );
    }
    return connector.createInstrument(input);
  }

  async getPaymentSession(id: SessionId): Promise<Session | undefined> {
    return this.sessionManager.getSession(id);
  }

  // ---- Connector registry --------------------------------------------------

  registerConnector(connector: WalletConnector): void {
    const caps = connector.getCapabilities();
    this.connectors.set(caps.walletProvider, connector);
  }

  getConnector(provider: WalletProviderId): WalletConnector | undefined {
    return this.connectors.get(provider);
  }

  listProviders(): readonly WalletProviderId[] {
    return Array.from(this.connectors.keys()) as WalletProviderId[];
  }

  // ---- Core data plane: processPayment -------------------------------------

  async processPayment(input: ProcessPaymentInput): Promise<ProcessPaymentOutput> {
    // 1. Resolve session
    const session = await this.sessionManager.getSession(input.sessionId);
    if (!session) {
      throw new PaymentManagerError(
        `Session ${input.sessionId} not found`,
        "session_not_found"
      );
    }

    // 2. Resolve instrument
    const instrument = await this.resolveInstrument(input.instrumentId);
    if (!instrument) {
      throw new PaymentManagerError(
        `Instrument ${input.instrumentId} not found`,
        "instrument_not_found"
      );
    }

    // 3. Resolve connector
    const connector = this.connectors.get(instrument.walletProvider);
    if (!connector) {
      throw new PaymentManagerError(
        `No connector registered for wallet provider: ${instrument.walletProvider}`,
        "connector_not_registered"
      );
    }

    // 4. Reserve budget
    const reservation = await this.sessionManager.checkAndReserve(
      session.id,
      input.request.amount
    );
    if (!reservation.approved) {
      throw new PaymentManagerError(
        `Session reservation rejected: ${reservation.reason}`,
        "session_rejected"
      );
    }

    // 5. Sign + settle
    let signed: SignedAuthorization;
    let settlement: SettlementResult;
    try {
      signed = await connector.signAuthorization({
        instrumentId: instrument.id,
        request: input.request,
        session,
      });
      settlement = await connector.settle(signed);
    } catch (err) {
      // Release reservation on failure
      await this.sessionManager.commit(session.id, input.request.amount, false);
      throw new PaymentManagerError(
        `Settlement failed: ${err instanceof Error ? err.message : String(err)}`,
        "settlement_failed"
      );
    }

    // 6. Commit / release based on result
    const sessionAfter = await this.sessionManager.commit(
      session.id,
      input.request.amount,
      settlement.success
    );

    // 6b. Record successful settlements into the refund ledger.
    if (settlement.success && settlement.transactionRef !== undefined) {
      this.settlementLedger.set(settlement.transactionRef, {
        amount: settlement.settledAmount ?? input.request.amount,
        refundedAtomic: 0n,
      });
    }

    // Note: signed has `extra` which can have an undefined value. Strip it
    // to avoid TS exactOptionalPropertyTypes complaining about the optional
    // shape difference.
    return {
      success: settlement.success,
      settlement,
      signed,
      sessionAfter,
    };
  }

  // ---- Refund ---------------------------------------------------------------

  async refund(req: RefundRequest): Promise<RefundResult> {
    // 1. Idempotency: replay prior result for a repeated (ref, key) pair.
    const idemKey =
      req.idempotencyKey !== undefined
        ? `${req.originalTransactionRef}:${req.idempotencyKey}`
        : undefined;
    if (idemKey !== undefined) {
      const prior = this.refundIdempotency.get(idemKey);
      if (prior) {
        return prior.success
          ? prior
          : { ...prior, errorCode: "already_refunded" };
      }
    }

    // 2. Original must exist in the settlement ledger.
    const entry = this.settlementLedger.get(req.originalTransactionRef);
    if (!entry) {
      return {
        success: false,
        errorCode: "original_not_found",
        errorMessage: `No settled payment for ${req.originalTransactionRef}`,
      };
    }

    // 3. Currency must match the original settlement.
    if (req.amount.currency !== entry.amount.currency) {
      return {
        success: false,
        errorCode: "exceeds_original",
        errorMessage: `Refund currency ${req.amount.currency} != original ${entry.amount.currency}`,
      };
    }

    // 4. Refund amount + already-refunded must not exceed the original.
    const want = BigInt(req.amount.amountAtomic);
    const original = BigInt(entry.amount.amountAtomic);
    if (want < 0n || entry.refundedAtomic + want > original) {
      return {
        success: false,
        errorCode: "exceeds_original",
        errorMessage: `Refund ${want} + prior ${entry.refundedAtomic} > original ${original}`,
      };
    }

    // 5. Must have a refund backend wired.
    if (!this.refundExecutor) {
      return {
        success: false,
        errorCode: "not_supported",
        errorMessage: "No RefundExecutor configured on this PaymentManager",
      };
    }

    // 6. Delegate to the executor.
    const result = await this.refundExecutor.refund(req);

    // 7. On success, advance the refunded tally and cache for idempotency.
    if (result.success) {
      entry.refundedAtomic += want;
    }
    if (idemKey !== undefined) {
      this.refundIdempotency.set(idemKey, result);
    }
    return result;
  }
}

/** Internal ledger row tracking how much of a settled payment is refundable. */
interface SettlementLedgerEntry {
  readonly amount: Money;
  refundedAtomic: bigint;
}

// ============================================================================
//  Helpers — also used by tests
// ============================================================================

/**
 * Create a PaymentManager with an InstrumentStore-backed instrument resolver.
 * This is the most common way to construct one in tests + smoke scripts.
 */
export function createInMemoryPaymentManager(opts: {
  resolveInstrument: (id: InstrumentId) => Promise<Instrument | undefined>;
  sessionManager?: SessionManager;
  connectors?: readonly WalletConnector[];
  refundExecutor?: RefundExecutor;
}): InMemoryPaymentManager {
  const config: InMemoryPaymentManagerConfig = {
    resolveInstrument: opts.resolveInstrument,
    ...(opts.sessionManager !== undefined
      ? { sessionManager: opts.sessionManager }
      : {}),
    ...(opts.refundExecutor !== undefined
      ? { refundExecutor: opts.refundExecutor }
      : {}),
  };
  const mgr = new InMemoryPaymentManager(config);
  for (const c of opts.connectors ?? []) {
    mgr.registerConnector(c);
  }
  return mgr;
}

// Type helper used by consumers — exported here so users get a single import path.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _userId_unused: UserId = "alice" as UserId;
