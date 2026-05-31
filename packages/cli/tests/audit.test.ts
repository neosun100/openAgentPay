/**
 * @openagentpay/cli — `oap audit` subcommand tests.
 *
 * Writes a temporary JSONL audit fixture, then exercises the parse + filter
 * paths through the public `runCli(["audit", ...])` surface (and the exported
 * pure helpers parseJsonl / filterEvents).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "@openagentpay/governance";
import { runCli } from "../src/cli.js";
import { parseJsonl, filterEvents } from "../src/commands/audit.js";

const TMP = join(process.cwd(), ".tmp-cli-audit-test");
const FIXTURE = join(TMP, "audit.log.jsonl");

const EVENTS: AuditEvent[] = [
  {
    eventId: "audit-1",
    timestamp: "2026-05-01T08:00:00.000Z",
    kind: "policy_check",
    actor: "alice",
    result: "allowed",
    reason: "under threshold",
  },
  {
    eventId: "audit-2",
    timestamp: "2026-05-10T09:30:00.000Z",
    kind: "policy_check",
    actor: "bob",
    result: "denied",
    reason: "velocity limit",
  },
  {
    eventId: "audit-3",
    timestamp: "2026-05-20T12:00:00.000Z",
    kind: "payment_success",
    actor: "alice",
    result: "succeeded",
    txHash: "0xabc",
  },
  {
    eventId: "audit-4",
    timestamp: "2026-05-25T15:45:00.000Z",
    kind: "payment_failure",
    actor: "carol",
    result: "failed",
    reason: "rpc timeout",
  },
];

function writeFixture(events: ReadonlyArray<AuditEvent>): void {
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(FIXTURE, jsonl, "utf8");
}

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFixture(EVENTS);
});

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
//  Pure helpers
// ---------------------------------------------------------------------------

describe("audit helpers — parseJsonl", () => {
  it("parses newline-delimited events and skips blank/malformed lines", () => {
    const warnings: string[] = [];
    const raw = [
      JSON.stringify(EVENTS[0]),
      "", // blank
      "{not json}", // malformed
      JSON.stringify(EVENTS[1]),
    ].join("\n");
    const parsed = parseJsonl(raw, (ln, msg) => warnings.push(`${ln}:${msg}`));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.eventId).toBe("audit-1");
    expect(parsed[1]!.eventId).toBe("audit-2");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("3:"); // malformed line number
  });
});

describe("audit helpers — filterEvents", () => {
  it("applies kind/actor/result/since with AND semantics", () => {
    expect(filterEvents(EVENTS, { kind: "policy_check" })).toHaveLength(2);
    expect(filterEvents(EVENTS, { actor: "alice" })).toHaveLength(2);
    expect(filterEvents(EVENTS, { result: "denied" })).toHaveLength(1);
    expect(
      filterEvents(EVENTS, { actor: "alice", result: "succeeded" })
    ).toHaveLength(1);
    expect(
      filterEvents(EVENTS, { since: "2026-05-15T00:00:00.000Z" })
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
//  CLI surface
// ---------------------------------------------------------------------------

describe("oap audit — CLI", () => {
  it("filters by --kind", async () => {
    const r = await runCli(["audit", "--file", FIXTURE, "--kind", "policy_check"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2 events");
    expect(r.stdout).toContain("alice");
    expect(r.stdout).toContain("bob");
    expect(r.stdout).not.toContain("payment_success");
  });

  it("filters by --since (inclusive of newer events)", async () => {
    const r = await runCli([
      "audit",
      "--file",
      FIXTURE,
      "--since",
      "2026-05-15T00:00:00.000Z",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2 events");
    expect(r.stdout).toContain("payment_success");
    expect(r.stdout).toContain("payment_failure");
    expect(r.stdout).not.toContain("velocity limit");
  });

  it("filters by --result", async () => {
    const r = await runCli(["audit", "--file", FIXTURE, "--result", "failed"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 event");
    expect(r.stdout).toContain("carol");
    expect(r.stdout).toContain("rpc timeout");
  });

  it("filters by --actor", async () => {
    const r = await runCli(["audit", "--file", FIXTURE, "--actor", "alice"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2 events");
    expect(r.stdout).not.toContain("bob");
  });

  it("emits a JSON array with --json", async () => {
    const r = await runCli([
      "audit",
      "--file",
      FIXTURE,
      "--actor",
      "alice",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const arr = JSON.parse(r.stdout) as AuditEvent[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(2);
    expect(arr.every((e) => e.actor === "alice")).toBe(true);
  });

  it("combines filters (AND) and prints 0 events when none match", async () => {
    const r = await runCli([
      "audit",
      "--file",
      FIXTURE,
      "--actor",
      "bob",
      "--result",
      "succeeded",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("0 events");
  });

  it("returns exit 6 when the audit file does not exist", async () => {
    const missing = join(TMP, "nope.jsonl");
    const r = await runCli(["audit", "--file", missing]);
    expect(r.exitCode).toBe(6);
    expect(r.stderr).toContain("audit file not found");
  });

  it("returns exit 2 on an invalid --kind value", async () => {
    const r = await runCli(["audit", "--file", FIXTURE, "--kind", "bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid --kind");
  });

  it("returns exit 2 on an invalid --result value", async () => {
    const r = await runCli(["audit", "--file", FIXTURE, "--result", "maybe"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid --result");
  });

  it("--json on an empty match prints an empty array, exit 0", async () => {
    const r = await runCli([
      "audit",
      "--file",
      FIXTURE,
      "--actor",
      "nobody",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const arr = JSON.parse(r.stdout) as AuditEvent[];
    expect(arr).toEqual([]);
  });

  it("is listed in top-level help", async () => {
    const r = await runCli(["help"]);
    expect(r.stdout).toContain("audit");
  });
});
