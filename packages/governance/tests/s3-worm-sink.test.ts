/**
 * S3WormAuditSink unit tests — using a mock S3-like client (no real AWS calls).
 *
 * Coverage:
 *   - constructor validation (missing bucket, invalid retention)
 *   - emit() — sends PutObjectCommand with correct Bucket/Key/Body/ContentType
 *   - emit() — key layout {prefix}/{actor}/{ISO8601}-{eventId}.json
 *   - emit() — ObjectLockMode = COMPLIANCE present (WORM guarantee)
 *   - emit() — RetainUntilDate ≈ now + default 2555 days
 *   - emit() — custom retention honored
 *   - emit() — prefix normalized (leading/trailing slashes stripped)
 *   - emit() — JSON body round-trips the AuditEvent
 *   - emit() — injected now() drives the retention math deterministically
 *   - DEFAULT_WORM_RETENTION_DAYS export
 */

import { describe, expect, it, vi } from "vitest";
import {
  S3WormAuditSink,
  DEFAULT_WORM_RETENTION_DAYS,
} from "../src/s3-worm-sink.js";
import type { AuditEvent } from "../src/audit.js";
import type { S3ClientLike } from "../src/s3-worm-sink.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function buildSink(
  cfg: {
    prefix?: string;
    objectLockRetentionDays?: number;
    now?: () => Date;
  } = {}
) {
  const calls: Array<{ cmdName: string; input: any }> = [];
  const client: S3ClientLike = {
    send: vi.fn(async (cmd: any) => {
      calls.push({ cmdName: cmd.__cmdName, input: cmd.input });
      return {};
    }),
  };
  // Test command factory that marks the cmd type for routing.
  const commands = {
    PutObject: (input: Record<string, unknown>) => ({
      input,
      __cmdName: "PutObjectCommand",
    }),
  };
  const sink = new S3WormAuditSink({
    bucket: "test-worm-bucket",
    client,
    commands,
    ...(cfg.prefix !== undefined ? { prefix: cfg.prefix } : {}),
    ...(cfg.objectLockRetentionDays !== undefined
      ? { objectLockRetentionDays: cfg.objectLockRetentionDays }
      : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
  });
  return { sink, client, calls };
}

const FIXED_NOW = new Date("2026-05-19T10:00:00.000Z");

const SAMPLE_EVENT: AuditEvent = {
  eventId: "audit-abc-12345",
  timestamp: "2026-05-19T10:00:00.000Z",
  kind: "payment_success",
  actor: "alice",
  walletProvider: "coinbase-cdp",
  sessionId: "sess-1",
  recipient: "0x123",
  amountAtomic: "1000000",
  currency: "USDC",
  chain: "base-sepolia",
  txHash: "0xdeadbeef",
  result: "succeeded",
  metadata: { reason: "buy report" },
};

// ============================================================================
//  Constructor
// ============================================================================

describe("S3WormAuditSink — constructor", () => {
  it("rejects missing bucket", () => {
    expect(
      () =>
        new S3WormAuditSink({
          bucket: "",
          client: { send: async () => ({}) },
        })
    ).toThrow(/bucket/);
  });

  it("rejects non-positive retention", () => {
    expect(
      () =>
        new S3WormAuditSink({
          bucket: "b",
          objectLockRetentionDays: 0,
          client: { send: async () => ({}) },
        })
    ).toThrow(/objectLockRetentionDays/);
    expect(
      () =>
        new S3WormAuditSink({
          bucket: "b",
          objectLockRetentionDays: -5,
          client: { send: async () => ({}) },
        })
    ).toThrow(/objectLockRetentionDays/);
  });

  it("exports DEFAULT_WORM_RETENTION_DAYS = 2555 (~7y SOX)", () => {
    expect(DEFAULT_WORM_RETENTION_DAYS).toBe(2555);
  });
});

// ============================================================================
//  emit — basic PUT shape
// ============================================================================

describe("S3WormAuditSink — emit", () => {
  it("sends a PutObjectCommand to the configured bucket", async () => {
    const { sink, calls } = buildSink({ now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);

    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.cmdName).toBe("PutObjectCommand");
    expect(c.input.Bucket).toBe("test-worm-bucket");
    expect(c.input.ContentType).toBe("application/json");
  });

  it("uses key layout {prefix}/{actor}/{ISO8601}-{eventId}.json", async () => {
    const { sink, calls } = buildSink({ prefix: "audit", now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);
    const key = calls[0]!.input.Key as string;
    expect(key).toBe(
      "audit/alice/2026-05-19T10:00:00.000Z-audit-abc-12345.json"
    );
  });

  it("applies a custom prefix and normalizes slashes", async () => {
    const { sink, calls } = buildSink({
      prefix: "/logs/worm/",
      now: () => FIXED_NOW,
    });
    await sink.emit(SAMPLE_EVENT);
    const key = calls[0]!.input.Key as string;
    expect(key).toBe(
      "logs/worm/alice/2026-05-19T10:00:00.000Z-audit-abc-12345.json"
    );
  });

  it("uses default prefix 'audit' when none provided", async () => {
    const { sink, calls } = buildSink({ now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);
    const key = calls[0]!.input.Key as string;
    expect(key.startsWith("audit/alice/")).toBe(true);
  });

  it("omits the prefix segment when prefix is empty string", async () => {
    const { sink, calls } = buildSink({ prefix: "", now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);
    const key = calls[0]!.input.Key as string;
    expect(key).toBe("alice/2026-05-19T10:00:00.000Z-audit-abc-12345.json");
  });
});

// ============================================================================
//  emit — WORM / Object Lock guarantees
// ============================================================================

describe("S3WormAuditSink — Object Lock (WORM)", () => {
  it("sets ObjectLockMode = COMPLIANCE", async () => {
    const { sink, calls } = buildSink({ now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);
    expect(calls[0]!.input.ObjectLockMode).toBe("COMPLIANCE");
  });

  it("sets RetainUntilDate ≈ now + default 2555 days", async () => {
    const { sink, calls } = buildSink({ now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);
    const retainUntil = calls[0]!.input.ObjectLockRetainUntilDate as Date;
    expect(retainUntil).toBeInstanceOf(Date);
    const expected = FIXED_NOW.getTime() + 2555 * MS_PER_DAY;
    expect(retainUntil.getTime()).toBe(expected);
  });

  it("honors a custom retention period", async () => {
    const { sink, calls } = buildSink({
      objectLockRetentionDays: 30,
      now: () => FIXED_NOW,
    });
    await sink.emit(SAMPLE_EVENT);
    const retainUntil = calls[0]!.input.ObjectLockRetainUntilDate as Date;
    expect(retainUntil.getTime()).toBe(FIXED_NOW.getTime() + 30 * MS_PER_DAY);
  });

  it("injected now() drives the retention math deterministically", async () => {
    const t1 = new Date("2030-01-01T00:00:00.000Z");
    const { sink, calls } = buildSink({
      objectLockRetentionDays: 1,
      now: () => t1,
    });
    await sink.emit(SAMPLE_EVENT);
    const retainUntil = calls[0]!.input.ObjectLockRetainUntilDate as Date;
    expect(retainUntil.toISOString()).toBe("2030-01-02T00:00:00.000Z");
  });
});

// ============================================================================
//  emit — body round-trips
// ============================================================================

describe("S3WormAuditSink — body serialization", () => {
  it("Body is JSON that round-trips back to the AuditEvent", async () => {
    const { sink, calls } = buildSink({ now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);
    const body = calls[0]!.input.Body as string;
    expect(typeof body).toBe("string");
    const parsed = JSON.parse(body) as AuditEvent;
    expect(parsed).toEqual(SAMPLE_EVENT);
  });

  it("round-trips nested policy/compliance fields", async () => {
    const { sink, calls } = buildSink({ now: () => FIXED_NOW });
    const event: AuditEvent = {
      ...SAMPLE_EVENT,
      policyEvaluations: [
        { allowed: false, policyName: "amountThreshold", reason: "too big" },
      ],
      complianceCheck: {
        cleared: false,
        checkerName: "StaticSanctionsChecker",
        matches: [{ address: "0xBAD", source: "OFAC", reason: "match" }],
      },
    };
    await sink.emit(event);
    const parsed = JSON.parse(calls[0]!.input.Body as string) as AuditEvent;
    expect(parsed.policyEvaluations).toEqual(event.policyEvaluations);
    expect(parsed.complianceCheck).toEqual(event.complianceCheck);
  });
});

// ============================================================================
//  emit — multiple events get distinct immutable keys
// ============================================================================

describe("S3WormAuditSink — write-once semantics", () => {
  it("distinct events map to distinct keys (no overwrite)", async () => {
    const { sink, calls } = buildSink({ now: () => FIXED_NOW });
    await sink.emit(SAMPLE_EVENT);
    await sink.emit({
      ...SAMPLE_EVENT,
      eventId: "audit-def-67890",
      timestamp: "2026-05-19T10:00:01.000Z",
    });
    expect(calls.length).toBe(2);
    const keys = calls.map((c) => c.input.Key as string);
    expect(new Set(keys).size).toBe(2);
  });
});
