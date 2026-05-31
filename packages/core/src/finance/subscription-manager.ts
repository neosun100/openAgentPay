/**
 * SubscriptionManager — prepaid credit ledger / recurring billing
 * ================================================================
 *
 * Productizes the `Subscription` / `SubscriptionPlan` / `BurnCredits*` types
 * from finance/types.ts into a working runtime:
 *
 *   createSubscription → mint a credit ledger for (user, wallet, plan)
 *   burnCredits        → atomically decrement credits, idempotent on key
 *   renew              → reset credits to plan total, extend expiry
 *   cancel             → mark cancelled (no more burns)
 *   getSubscription    → read by id
 *   listByUser         → all subscriptions for a user
 *
 * All credit math is done with BigInt over the atomic-string representation —
 * never float. burnCredits is idempotent: replaying the same idempotencyKey
 * returns the prior result without double-decrementing.
 *
 * @license Apache-2.0
 */

import { randomUUID } from "node:crypto";
import type {
  BurnCreditsInput,
  BurnCreditsResult,
  Subscription,
  SubscriptionPlan,
} from "./types.js";
import type { UserId, WalletProviderId } from "../types.js";

// ============================================================================
//  Public interface
// ============================================================================

export interface SubscriptionManager {
  /** Mint a new subscription seeded with the plan's full credit balance. */
  createSubscription(
    userId: UserId,
    walletProvider: WalletProviderId,
    plan: SubscriptionPlan,
    options?: CreateSubscriptionOptions
  ): Promise<Subscription>;

  /** Read a subscription by id (undefined if not found). */
  getSubscription(id: string): Promise<Subscription | undefined>;

  /** Atomically burn credits. Idempotent on `idempotencyKey`. */
  burnCredits(input: BurnCreditsInput): Promise<BurnCreditsResult>;

  /** Reset credits to plan total and extend expiry by plan.periodDays. */
  renew(id: string): Promise<Subscription>;

  /** Mark a subscription cancelled — further burns are rejected. */
  cancel(id: string): Promise<Subscription>;

  /** Pause a subscription — burns rejected with subscription_paused. */
  pause(id: string): Promise<Subscription>;

  /** Resume a paused subscription back to active. */
  resume(id: string): Promise<Subscription>;

  /** All subscriptions belonging to a user. */
  listByUser(userId: UserId): Promise<Subscription[]>;
}

export interface CreateSubscriptionOptions {
  /** Credit currency symbol (default: "CREDIT"). */
  readonly creditCurrency?: string;
  /** Free-form metadata stored on the subscription. */
  readonly metadata?: Record<string, string>;
}

// ============================================================================
//  Errors
// ============================================================================

export class SubscriptionError extends Error {
  override readonly name = "SubscriptionError";
  constructor(
    message: string,
    public readonly code: "subscription_not_found" | "invalid_state" | "internal"
  ) {
    super(message);
  }
}

// ============================================================================
//  In-memory implementation
// ============================================================================

const DEFAULT_CREDIT_CURRENCY = "CREDIT";

/** Mutable view used internally — Subscription is readonly to consumers. */
type MutableSubscription = {
  -readonly [K in keyof Subscription]: Subscription[K];
};

export class InMemorySubscriptionManager implements SubscriptionManager {
  private readonly store = new Map<string, MutableSubscription>();
  /** idempotencyKey → cached burn result (per subscription scope baked into key). */
  private readonly burnLedger = new Map<string, BurnCreditsResult>();

  constructor(private readonly now: () => number = Date.now) {}

  async createSubscription(
    userId: UserId,
    walletProvider: WalletProviderId,
    plan: SubscriptionPlan,
    options?: CreateSubscriptionOptions
  ): Promise<Subscription> {
    const id = `subscription-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const startedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(
      this.now() + plan.periodDays * 86_400_000
    ).toISOString();
    const sub: MutableSubscription = {
      id,
      userId,
      walletProvider,
      plan,
      creditsRemainingAtomic: plan.creditsAtomic,
      creditsTotalAtomic: plan.creditsAtomic,
      creditDecimals: plan.creditDecimals,
      creditCurrency: options?.creditCurrency ?? DEFAULT_CREDIT_CURRENCY,
      status: "active",
      startedAt,
      expiresAt,
      ...(options?.metadata !== undefined &&
      Object.keys(options.metadata).length > 0
        ? { metadata: options.metadata }
        : {}),
    };
    this.store.set(id, sub);
    return this.snapshot(sub);
  }

  async getSubscription(id: string): Promise<Subscription | undefined> {
    const sub = this.store.get(id);
    if (!sub) return undefined;
    this.materialize(sub);
    return this.snapshot(sub);
  }

  async burnCredits(input: BurnCreditsInput): Promise<BurnCreditsResult> {
    const sub = this.store.get(input.subscriptionId);
    if (!sub) {
      return {
        success: false,
        creditsRemainingAtomic: "0",
        errorCode: "subscription_not_found",
      };
    }

    // Idempotency: scope the key to the subscription so the same key on a
    // different subscription doesn't collide.
    const idemScopedKey =
      input.idempotencyKey !== undefined
        ? `${input.subscriptionId}:${input.idempotencyKey}`
        : undefined;
    if (idemScopedKey !== undefined) {
      const cached = this.burnLedger.get(idemScopedKey);
      if (cached) return cached;
    }

    this.materialize(sub);

    if (sub.status === "expired") {
      return {
        success: false,
        creditsRemainingAtomic: sub.creditsRemainingAtomic,
        errorCode: "subscription_expired",
      };
    }
    if (sub.status === "paused") {
      return {
        success: false,
        creditsRemainingAtomic: sub.creditsRemainingAtomic,
        errorCode: "subscription_paused",
      };
    }
    if (sub.status === "cancelled") {
      // Cancelled is a terminal state; treat as not-found for burn purposes.
      return {
        success: false,
        creditsRemainingAtomic: sub.creditsRemainingAtomic,
        errorCode: "subscription_not_found",
      };
    }

    const want = BigInt(input.amountAtomic);
    const have = BigInt(sub.creditsRemainingAtomic);
    if (want < 0n) {
      return {
        success: false,
        creditsRemainingAtomic: sub.creditsRemainingAtomic,
        errorCode: "unknown",
      };
    }
    if (want > have) {
      const result: BurnCreditsResult = {
        success: false,
        creditsRemainingAtomic: sub.creditsRemainingAtomic,
        errorCode: "insufficient_credits",
      };
      // Do NOT cache failures — caller may retry after renew().
      return result;
    }

    sub.creditsRemainingAtomic = (have - want).toString();
    const result: BurnCreditsResult = {
      success: true,
      creditsRemainingAtomic: sub.creditsRemainingAtomic,
    };
    if (idemScopedKey !== undefined) {
      this.burnLedger.set(idemScopedKey, result);
    }
    return result;
  }

  async renew(id: string): Promise<Subscription> {
    const sub = this.requireSub(id);
    sub.creditsRemainingAtomic = sub.plan.creditsAtomic;
    sub.creditsTotalAtomic = sub.plan.creditsAtomic;
    // Extend from the later of (now, current expiry) so renewing early stacks.
    const base = Math.max(this.now(), new Date(sub.expiresAt).getTime());
    sub.expiresAt = new Date(base + sub.plan.periodDays * 86_400_000).toISOString();
    sub.status = "active";
    return this.snapshot(sub);
  }

  async cancel(id: string): Promise<Subscription> {
    const sub = this.requireSub(id);
    sub.status = "cancelled";
    return this.snapshot(sub);
  }

  async pause(id: string): Promise<Subscription> {
    const sub = this.requireSub(id);
    this.materialize(sub);
    if (sub.status === "active") sub.status = "paused";
    return this.snapshot(sub);
  }

  async resume(id: string): Promise<Subscription> {
    const sub = this.requireSub(id);
    this.materialize(sub);
    if (sub.status === "paused") sub.status = "active";
    return this.snapshot(sub);
  }

  async listByUser(userId: UserId): Promise<Subscription[]> {
    const out: Subscription[] = [];
    for (const sub of this.store.values()) {
      if (sub.userId === userId) {
        this.materialize(sub);
        out.push(this.snapshot(sub));
      }
    }
    return out;
  }

  // ---- internals ----------------------------------------------------------

  private requireSub(id: string): MutableSubscription {
    const sub = this.store.get(id);
    if (!sub) {
      throw new SubscriptionError(
        `Subscription ${id} not found`,
        "subscription_not_found"
      );
    }
    return sub;
  }

  /** Lazily flip active→expired once the TTL passes. */
  private materialize(sub: MutableSubscription): void {
    if (
      (sub.status === "active" || sub.status === "paused") &&
      new Date(sub.expiresAt).getTime() <= this.now()
    ) {
      sub.status = "expired";
    }
  }

  /** Frozen public-shaped copy so consumers can't mutate internal state. */
  private snapshot(sub: MutableSubscription): Subscription {
    return { ...sub };
  }
}
