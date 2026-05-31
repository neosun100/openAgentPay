/**
 * `oap audit` — read & filter an append-only audit log (JSONL).
 *
 * The CLI is stateless, so it cannot reach into a live `InMemoryAuditSink`.
 * Instead it reads newline-delimited JSON {@link AuditEvent}s from a file
 * (default `./audit.log.jsonl`) and applies the *same* filter semantics as
 * `InMemoryAuditSink.query({ kind, actor, result, since })`.
 *
 * Usage:
 *   oap audit [--file PATH] [--since YYYY-MM-DD] [--kind <kind>]
 *             [--actor <id>] [--result <allowed|denied|succeeded|failed|info>]
 *             [--json]
 *
 * Exit codes:
 *   0    success (including zero matches — prints "0 events")
 *   2    invalid argument (e.g. unknown --kind / --result value)
 *   6    audit file not found
 *
 * @license Apache-2.0
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditEvent, AuditEventKind } from "@openagentpay/governance";

import { flag, pretty, type CommandContext } from "../io.js";

const DEFAULT_FILE = "audit.log.jsonl";

const KINDS: ReadonlyArray<AuditEventKind> = [
  "policy_check",
  "compliance_check",
  "payment_attempt",
  "payment_success",
  "payment_failure",
  "session_created",
  "session_expired",
];

const RESULTS: ReadonlyArray<AuditEvent["result"]> = [
  "allowed",
  "denied",
  "succeeded",
  "failed",
  "info",
];

interface AuditFilter {
  readonly kind?: AuditEventKind;
  readonly actor?: string;
  readonly result?: AuditEvent["result"];
  readonly since?: string; // ISO date
}

/**
 * Parse newline-delimited JSON {@link AuditEvent}s. Blank lines are skipped;
 * malformed lines are reported to stderr but do not abort the whole read.
 */
export function parseJsonl(
  raw: string,
  onWarn?: (line: number, message: string) => void
): AuditEvent[] {
  const out: AuditEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as AuditEvent;
      out.push(parsed);
    } catch {
      onWarn?.(i + 1, "skipping malformed JSON line");
    }
  }
  return out;
}

/**
 * Filter events with the same semantics as `InMemoryAuditSink.query`.
 * `since` is a lexicographic compare against ISO-8601 timestamps (valid because
 * ISO-8601 sorts chronologically as a string).
 */
export function filterEvents(
  events: ReadonlyArray<AuditEvent>,
  filter: AuditFilter
): AuditEvent[] {
  return events.filter((e) => {
    if (filter.kind && e.kind !== filter.kind) return false;
    if (filter.actor && e.actor !== filter.actor) return false;
    if (filter.result && e.result !== filter.result) return false;
    if (filter.since && e.timestamp < filter.since) return false;
    return true;
  });
}

function isKind(v: string): v is AuditEventKind {
  return (KINDS as ReadonlyArray<string>).includes(v);
}

function isResult(v: string): v is AuditEvent["result"] {
  return (RESULTS as ReadonlyArray<string>).includes(v);
}

/** Render one event as a compact table row. */
function row(e: AuditEvent): string {
  const ts = e.timestamp;
  const kind = e.kind.padEnd(17);
  const result = e.result.padEnd(9);
  const actor = (e.actor || "-").padEnd(16);
  const reason = e.reason ?? "";
  return `${ts}  ${kind}  ${result}  ${actor}  ${reason}`.trimEnd();
}

export async function cmdAudit(
  argv: ReadonlyArray<string>,
  ctx: CommandContext
): Promise<number> {
  const file = flag(argv, "--file", "-f") ?? DEFAULT_FILE;
  const since = flag(argv, "--since");
  const kindRaw = flag(argv, "--kind");
  const actor = flag(argv, "--actor");
  const resultRaw = flag(argv, "--result");
  const json = argv.includes("--json");

  // Validate enum-ish flags up front so the user gets a precise error.
  if (kindRaw !== undefined && !isKind(kindRaw)) {
    ctx.err(`✘ invalid --kind "${kindRaw}". Expected one of: ${KINDS.join(", ")}`);
    return 2;
  }
  if (resultRaw !== undefined && !isResult(resultRaw)) {
    ctx.err(
      `✘ invalid --result "${resultRaw}". Expected one of: ${RESULTS.join(", ")}`
    );
    return 2;
  }

  const abs = resolve(ctx.cwd, file);
  if (!existsSync(abs)) {
    ctx.err(`✘ audit file not found: ${abs}`);
    return 6;
  }

  const raw = readFileSync(abs, "utf8");
  const events = parseJsonl(raw, (lineNo, msg) =>
    ctx.err(`  ⚠ ${file}:${lineNo}: ${msg}`)
  );

  const filter: AuditFilter = {
    ...(kindRaw !== undefined ? { kind: kindRaw as AuditEventKind } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(resultRaw !== undefined
      ? { result: resultRaw as AuditEvent["result"] }
      : {}),
    ...(since !== undefined ? { since } : {}),
  };

  const matched = filterEvents(events, filter);

  if (json) {
    ctx.log(pretty(matched));
    return 0;
  }

  if (matched.length === 0) {
    ctx.log("0 events");
    return 0;
  }

  ctx.log(
    `timestamp                 kind               result     actor             reason`
  );
  for (const e of matched) {
    ctx.log(row(e));
  }
  ctx.log(`\n${matched.length} event${matched.length === 1 ? "" : "s"}`);
  return 0;
}
