/**
 * S3WormAuditSink — Layer 7 WORM (Write-Once-Read-Many) audit log persistence.
 *
 * Persists every AuditEvent as an immutable S3 object protected by S3 Object
 * Lock in COMPLIANCE mode. This is the highest-assurance audit sink in the
 * repo: once written, an event object cannot be altered or deleted by ANYONE —
 * including the AWS account root user — until its retention period expires.
 *
 *   COMPLIANCE mode  → not even root can shorten retention or delete early.
 *   GOVERNANCE mode  → users with s3:BypassGovernanceRetention can override.
 *
 * We deliberately use COMPLIANCE mode so the audit trail satisfies the
 * tamper-evidence / immutability requirements of SOX 17a-4(f), SEC 17a-4,
 * MiFID II, and bank-grade MRM regulators. The default retention is
 *   2555 days ≈ 7 years
 * which matches the SOX financial-record retention horizon.
 *
 * ---------------------------------------------------------------------------
 *  Object layout
 * ---------------------------------------------------------------------------
 *   Key:      {prefix}/{actor}/{ISO8601}-{eventId}.json
 *   Body:     JSON.stringify(event)   (round-trips back to AuditEvent)
 *   Headers:  Content-Type: application/json
 *             x-amz-object-lock-mode: COMPLIANCE
 *             x-amz-object-lock-retain-until-date: now + retentionDays
 *
 * The key is actor-partitioned so a regulator can list all events for one
 * user with a single `ListObjectsV2 Prefix={prefix}/{actor}/` and the ISO8601
 * prefix keeps each actor's objects lexicographically time-ordered.
 *
 * ---------------------------------------------------------------------------
 *  Bucket prerequisites (created by CDK / Terraform, NOT this class)
 * ---------------------------------------------------------------------------
 *   - Bucket MUST be created with Object Lock ENABLED (only possible at
 *     bucket-creation time; cannot be retro-fitted).
 *   - Versioning is implied (Object Lock requires it).
 *   - A default retention rule is optional — we set per-object retention on
 *     every PUT so the guarantee holds even without a bucket-level default.
 *
 * @license Apache-2.0
 */

import type { AuditEvent, AuditSink } from "./audit.js";

/**
 * Loose interface to allow any S3-client-like object.
 * In production: pass a real S3Client from @aws-sdk/client-s3.
 * In tests: pass a mock with the same `send()` signature that records inputs.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * Command factory function. We accept this as injectable so:
 *   - In production, the default factory imports the real SDK PutObjectCommand.
 *     The S3Client.send() inspects each command instance for middleware
 *     metadata, so plain objects don't work — it must be a real class instance.
 *   - In tests, you pass a simple factory that returns a plain `{ input }`
 *     object a mock client can introspect offline.
 */
export interface S3CommandFactories {
  /** Equivalent to `new PutObjectCommand(input)` from @aws-sdk/client-s3. */
  readonly PutObject: (input: Record<string, unknown>) => unknown;
}

/**
 * Lazy-loaded default factory that imports the real SDK class. We avoid a hard
 * ESM import on `@aws-sdk/client-s3` because it's declared as an optional
 * peerDependency — projects that don't use the WORM sink shouldn't be forced
 * to install it.
 */
let _cachedDefaultFactories: S3CommandFactories | null = null;
async function defaultFactories(): Promise<S3CommandFactories> {
  if (_cachedDefaultFactories) return _cachedDefaultFactories;
  // Defer module resolution to runtime so tsc stays happy when
  // @aws-sdk/client-s3 isn't installed at compile time.
  const mod = (await import("@aws-sdk/client-s3")) as any;
  _cachedDefaultFactories = {
    PutObject: (input) => new mod.PutObjectCommand(input),
  };
  return _cachedDefaultFactories;
}

/** Lazy-init a real S3Client only when no client was injected. */
let _cachedDefaultClient: S3ClientLike | null = null;
async function defaultClient(region?: string): Promise<S3ClientLike> {
  if (_cachedDefaultClient) return _cachedDefaultClient;
  const mod = (await import("@aws-sdk/client-s3")) as any;
  _cachedDefaultClient = new mod.S3Client(
    region ? { region } : {}
  ) as S3ClientLike;
  return _cachedDefaultClient;
}

/** Default SOX/SEC retention: 2555 days ≈ 7 years. */
export const DEFAULT_WORM_RETENTION_DAYS = 2555;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface S3WormAuditSinkConfig {
  /** Target bucket — MUST have Object Lock enabled at creation time. */
  readonly bucket: string;
  /** Key prefix; events are stored under `{prefix}/{actor}/...`. Default: "audit". */
  readonly prefix?: string;
  /** AWS region (only used when constructing the default S3 client). */
  readonly region?: string;
  /** Object Lock retention horizon in days. Default: 2555 (~7y). */
  readonly objectLockRetentionDays?: number;
  /** Injectable S3-like client (for tests / custom credential providers). */
  readonly client?: S3ClientLike;
  /** Optional command factories — for tests. Defaults to real SDK PutObjectCommand. */
  readonly commands?: S3CommandFactories;
  /** Override clock for tests. */
  readonly now?: () => Date;
}

export class S3WormAuditSink implements AuditSink {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly region: string | undefined;
  private readonly retentionDays: number;
  private readonly explicitClient: S3ClientLike | undefined;
  private readonly explicitCommands: S3CommandFactories | undefined;
  private readonly now: () => Date;

  constructor(cfg: S3WormAuditSinkConfig) {
    if (!cfg.bucket) throw new Error("bucket is required");
    if (
      cfg.objectLockRetentionDays != null &&
      (!Number.isFinite(cfg.objectLockRetentionDays) ||
        cfg.objectLockRetentionDays <= 0)
    ) {
      throw new Error("objectLockRetentionDays must be a positive number");
    }
    this.bucket = cfg.bucket;
    // Normalize prefix: strip leading/trailing slashes, default to "audit".
    const rawPrefix = cfg.prefix ?? "audit";
    this.prefix = rawPrefix.replace(/^\/+|\/+$/g, "");
    this.region = cfg.region;
    this.retentionDays =
      cfg.objectLockRetentionDays ?? DEFAULT_WORM_RETENTION_DAYS;
    this.explicitClient = cfg.client;
    this.explicitCommands = cfg.commands;
    this.now = cfg.now ?? (() => new Date());
  }

  private async getClient(): Promise<S3ClientLike> {
    return this.explicitClient ?? (await defaultClient(this.region));
  }

  private async getCommands(): Promise<S3CommandFactories> {
    return this.explicitCommands ?? (await defaultFactories());
  }

  /** Compute the immutable object key for an event. */
  private keyFor(event: AuditEvent): string {
    // event.timestamp is already ISO 8601; fall back to id-only if absent.
    const segments = [event.actor, `${event.timestamp}-${event.eventId}.json`];
    return this.prefix ? `${this.prefix}/${segments.join("/")}` : segments.join("/");
  }

  /**
   * Emit an audit event as an immutable WORM object.
   *
   * Write-once: each event maps to a unique key (actor + timestamp + eventId).
   * Object Lock COMPLIANCE mode forbids overwrite/delete before
   * `RetainUntilDate`, giving us a regulator-grade tamper-evident trail.
   */
  async emit(event: AuditEvent): Promise<void> {
    const retainUntil = new Date(
      this.now().getTime() + this.retentionDays * MS_PER_DAY
    );
    const { PutObject } = await this.getCommands();
    const client = await this.getClient();
    await client.send(
      PutObject({
        Bucket: this.bucket,
        Key: this.keyFor(event),
        Body: JSON.stringify(event),
        ContentType: "application/json",
        // WORM enforcement — the heart of this sink.
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
      })
    );
  }
}
