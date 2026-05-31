/**
 * CertificateRegistry — pluggable store for issued certificates.
 *
 * The {@link InMemoryCertificateRegistry} is the reference backing for a future
 * public dashboard (oapconformance.io). A production deployment would swap in a
 * DB-backed implementation behind the same interface.
 *
 * Revocation is soft: a revoked cert is retained (for audit) but flagged, and
 * excluded from `list()` unless `includeRevoked` is requested.
 *
 * @license Apache-2.0
 */

import type { ConformanceCertificate } from "./certificate.js";

export interface RegistryEntry {
  readonly certificate: ConformanceCertificate;
  readonly revoked: boolean;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface ListOptions {
  /** Filter to a single subject (package name). */
  readonly subject?: string;
  /** Include soft-revoked entries (default false). */
  readonly includeRevoked?: boolean;
}

export interface CertificateRegistry {
  /** Store a certificate. Throws if its id already exists. */
  issue(cert: ConformanceCertificate): RegistryEntry;
  /** Fetch by certificate id, or undefined if absent. */
  get(id: string): RegistryEntry | undefined;
  /** List entries, optionally filtered by subject / revocation state. */
  list(options?: ListOptions): ReadonlyArray<RegistryEntry>;
  /** Soft-revoke a certificate. Returns false if id is unknown. */
  revoke(id: string, reason?: string): boolean;
  /** Number of stored entries (including revoked). */
  readonly size: number;
}

export class RegistryError extends Error {
  override readonly name = "RegistryError";
  constructor(
    message: string,
    public readonly code: "duplicate_id" | "not_found"
  ) {
    super(message);
  }
}

export class InMemoryCertificateRegistry implements CertificateRegistry {
  private readonly store = new Map<string, RegistryEntry>();

  issue(cert: ConformanceCertificate): RegistryEntry {
    if (this.store.has(cert.id)) {
      throw new RegistryError(
        `certificate id ${cert.id} already issued`,
        "duplicate_id"
      );
    }
    const entry: RegistryEntry = { certificate: cert, revoked: false };
    this.store.set(cert.id, entry);
    return entry;
  }

  get(id: string): RegistryEntry | undefined {
    return this.store.get(id);
  }

  list(options?: ListOptions): ReadonlyArray<RegistryEntry> {
    const includeRevoked = options?.includeRevoked ?? false;
    const subject = options?.subject;
    const out: RegistryEntry[] = [];
    for (const entry of this.store.values()) {
      if (!includeRevoked && entry.revoked) continue;
      if (subject !== undefined && entry.certificate.subject !== subject) {
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  revoke(id: string, reason?: string): boolean {
    const entry = this.store.get(id);
    if (!entry) return false;
    if (entry.revoked) return true;
    const revoked: RegistryEntry = {
      certificate: entry.certificate,
      revoked: true,
      revokedAt: new Date().toISOString(),
      ...(reason !== undefined ? { revokedReason: reason } : {}),
    };
    this.store.set(id, revoked);
    return true;
  }

  get size(): number {
    return this.store.size;
  }
}
