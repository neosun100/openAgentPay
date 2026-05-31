/**
 * Tests for InMemorySubscriptionManager.
 */

import { describe, expect, it } from "vitest";
import {
  InMemorySubscriptionManager,
  type SubscriptionPlan,
} from "../src/finance/index.js";
import type { UserId, WalletProviderId } from "../src/types.js";

const ALICE = "alice" as UserId;
const BOB = "bob" as UserId;
const WALLET = "mock-wallet" as WalletProviderId;

const PLAN: SubscriptionPlan = {
  id: "plan-basic",
  name: "Basic",
  priceUsd: 10,
  creditsAtomic: "1000000", // 1.0 credits @ 6dp
  creditDecimals: 6,
  periodDays: 30,
  autoRenew: false,
};

function freshMgr(start = 1_700_000_000_000): {
  mgr: InMemorySubscriptionManager;
  clock: { t: number };
} {
  const clock = { t: start };
  const mgr = new InMemorySubscriptionManager(() => clock.t);
  return { mgr, clock };
}

describe("InMemorySubscriptionManager.createSubscription", () => {
  it("seeds full credits and active status", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    expect(sub.creditsRemainingAtomic).toBe("1000000");
    expect(sub.creditsTotalAtomic).toBe("1000000");
    expect(sub.status).toBe("active");
    expect(sub.userId).toBe(ALICE);
    expect(sub.walletProvider).toBe(WALLET);
  });

  it("sets expiresAt periodDays into the future", async () => {
    const start = 1_700_000_000_000;
    const { mgr } = freshMgr(start);
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const expected = start + 30 * 86_400_000;
    expect(new Date(sub.expiresAt).getTime()).toBe(expected);
  });

  it("getSubscription round-trips by id", async () => {
    const { mgr } = freshMgr();
    const created = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const got = await mgr.getSubscription(created.id);
    expect(got?.id).toBe(created.id);
  });

  it("getSubscription returns undefined for unknown id", async () => {
    const { mgr } = freshMgr();
    expect(await mgr.getSubscription("nope")).toBe(undefined);
  });
});

describe("InMemorySubscriptionManager.burnCredits — happy path", () => {
  it("decrements credits atomically", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const r = await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "250000",
      reason: "api-call",
    });
    expect(r.success).toBe(true);
    expect(r.creditsRemainingAtomic).toBe("750000");
    const after = await mgr.getSubscription(sub.id);
    expect(after?.creditsRemainingAtomic).toBe("750000");
  });

  it("allows burning the exact remaining balance to zero", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const r = await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "1000000",
      reason: "all",
    });
    expect(r.success).toBe(true);
    expect(r.creditsRemainingAtomic).toBe("0");
  });
});

describe("InMemorySubscriptionManager.burnCredits — rejections", () => {
  it("rejects insufficient_credits without mutating balance", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const r = await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "2000000",
      reason: "too-much",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("insufficient_credits");
    expect(r.creditsRemainingAtomic).toBe("1000000");
  });

  it("rejects subscription_not_found", async () => {
    const { mgr } = freshMgr();
    const r = await mgr.burnCredits({
      subscriptionId: "ghost",
      amountAtomic: "1",
      reason: "x",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("subscription_not_found");
  });

  it("rejects subscription_expired after TTL passes", async () => {
    const { mgr, clock } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    clock.t += 31 * 86_400_000; // beyond the 30-day window
    const r = await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "1",
      reason: "late",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("subscription_expired");
  });

  it("rejects subscription_paused", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    await mgr.pause(sub.id);
    const r = await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "1",
      reason: "while-paused",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("subscription_paused");
  });
});

describe("InMemorySubscriptionManager.burnCredits — idempotency", () => {
  it("double-burn with same key only decrements once", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const input = {
      subscriptionId: sub.id,
      amountAtomic: "300000",
      reason: "idem",
      idempotencyKey: "burn-1",
    };
    const r1 = await mgr.burnCredits(input);
    const r2 = await mgr.burnCredits(input);
    expect(r1.creditsRemainingAtomic).toBe("700000");
    expect(r2.creditsRemainingAtomic).toBe("700000"); // replayed, not 400000
    const after = await mgr.getSubscription(sub.id);
    expect(after?.creditsRemainingAtomic).toBe("700000");
  });

  it("same key on different subscriptions does not collide", async () => {
    const { mgr } = freshMgr();
    const s1 = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const s2 = await mgr.createSubscription(BOB, WALLET, PLAN);
    await mgr.burnCredits({
      subscriptionId: s1.id,
      amountAtomic: "100000",
      reason: "x",
      idempotencyKey: "shared",
    });
    const r2 = await mgr.burnCredits({
      subscriptionId: s2.id,
      amountAtomic: "100000",
      reason: "x",
      idempotencyKey: "shared",
    });
    expect(r2.success).toBe(true);
    expect(r2.creditsRemainingAtomic).toBe("900000");
  });
});

describe("InMemorySubscriptionManager.renew / cancel / resume", () => {
  it("renew resets credits and extends expiry", async () => {
    const start = 1_700_000_000_000;
    const { mgr } = freshMgr(start);
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "900000",
      reason: "use",
    });
    const renewed = await mgr.renew(sub.id);
    expect(renewed.creditsRemainingAtomic).toBe("1000000");
    // expiry stacks from the prior expiry (early renew)
    const expected = start + 60 * 86_400_000;
    expect(new Date(renewed.expiresAt).getTime()).toBe(expected);
    expect(renewed.status).toBe("active");
  });

  it("renew reactivates an expired subscription", async () => {
    const { mgr, clock } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    clock.t += 40 * 86_400_000;
    // confirm it's expired first
    const expired = await mgr.getSubscription(sub.id);
    expect(expired?.status).toBe("expired");
    const renewed = await mgr.renew(sub.id);
    expect(renewed.status).toBe("active");
    expect(renewed.creditsRemainingAtomic).toBe("1000000");
  });

  it("cancel blocks further burns", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    const cancelled = await mgr.cancel(sub.id);
    expect(cancelled.status).toBe("cancelled");
    const r = await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "1",
      reason: "after-cancel",
    });
    expect(r.success).toBe(false);
  });

  it("pause then resume restores burn ability", async () => {
    const { mgr } = freshMgr();
    const sub = await mgr.createSubscription(ALICE, WALLET, PLAN);
    await mgr.pause(sub.id);
    await mgr.resume(sub.id);
    const r = await mgr.burnCredits({
      subscriptionId: sub.id,
      amountAtomic: "1",
      reason: "after-resume",
    });
    expect(r.success).toBe(true);
  });

  it("renew throws SubscriptionError for unknown id", async () => {
    const { mgr } = freshMgr();
    await expect(mgr.renew("ghost")).rejects.toThrow();
  });
});

describe("InMemorySubscriptionManager.listByUser", () => {
  it("returns only the user's subscriptions", async () => {
    const { mgr } = freshMgr();
    await mgr.createSubscription(ALICE, WALLET, PLAN);
    await mgr.createSubscription(ALICE, WALLET, PLAN);
    await mgr.createSubscription(BOB, WALLET, PLAN);
    const aliceSubs = await mgr.listByUser(ALICE);
    const bobSubs = await mgr.listByUser(BOB);
    expect(aliceSubs.length).toBe(2);
    expect(bobSubs.length).toBe(1);
    expect(aliceSubs.every((s) => s.userId === ALICE)).toBe(true);
  });
});
