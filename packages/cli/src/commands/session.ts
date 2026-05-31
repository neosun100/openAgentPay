/**
 * `oap session` subcommands — create + inspect payment sessions.
 *
 *   oap session create [--budget <usd>] [--expiry <minutes>] [--config PATH]
 *   oap session show   <id> [--config PATH]
 *
 * Sessions live in an in-process InMemoryPaymentManager, so within a single
 * CLI invocation `create` then `show` round-trips. Across separate process
 * invocations sessions are NOT persisted (in-memory only) — `show` of an id
 * from a prior process returns exit 5 (not found). This mirrors the local-dev
 * contract; production uses the DynamoDB-backed manager.
 *
 * Exit codes:
 *   0  success
 *   2  bad argv
 *   3  config load failure
 *   5  session not found
 *
 * @license Apache-2.0
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  ConfigError,
  loadConfig,
  type OpenAgentPayConfig,
} from "@openagentpay/config";
import {
  InMemoryPaymentManager,
  type CreateSessionInput,
  type Instrument,
  type InstrumentId,
  type PaymentManager,
  type SessionId,
  type UserId,
} from "@openagentpay/core";

import { firstPositional, flag, pretty, type CommandContext } from "../io.js";

const DEFAULT_CONFIG = "openagentpay.yaml";
const DEFAULT_BUDGET_USD = 10;
const DEFAULT_EXPIRY_MIN = 60;
const DEFAULT_USER = "oap-cli" as UserId;

// ============================================================================
//  Shared runtime construction
// ============================================================================

/**
 * Build a minimal in-process PaymentManager. Config is loaded (and validated)
 * if present so that the same yaml drives both `doctor` and the data-plane
 * commands, but wallet *modules* are NOT dynamically imported here (the CLI is
 * dependency-light by design) — connectors are registered lazily by callers
 * that need them. Returns the manager plus the loaded config (or undefined).
 */
export function buildRuntime(
  ctx: CommandContext,
  configPath: string | undefined
): { manager: InMemoryPaymentManager; config: OpenAgentPayConfig | undefined } {
  let config: OpenAgentPayConfig | undefined;
  if (configPath !== undefined) {
    const abs = resolve(ctx.cwd, configPath);
    if (!existsSync(abs)) {
      throw new ConfigError(`config not found: ${abs}`);
    }
    config = loadConfig(abs);
  }

  // Instruments are resolved from an in-process store keyed by id. `pay`
  // populates it on demand; `session` never needs it.
  const instruments = new Map<string, Instrument>();
  const manager = new InMemoryPaymentManager({
    resolveInstrument: async (id: InstrumentId) => instruments.get(id),
  });
  // Expose the backing store so `pay` can inject a synthetic instrument.
  (manager as RuntimeManager).__instruments = instruments;
  return { manager, config };
}

/** Internal augmentation: the in-process instrument store hung off the mgr. */
export interface RuntimeManager extends PaymentManager {
  __instruments?: Map<string, Instrument>;
}

// ============================================================================
//  oap session create
// ============================================================================

export async function cmdSessionCreate(
  argv: ReadonlyArray<string>,
  ctx: CommandContext,
  manager?: PaymentManager
): Promise<number> {
  const budgetStr = flag(argv, "--budget", "-b");
  const expiryStr = flag(argv, "--expiry", "-e");
  const configPath = flag(argv, "--config", "-c");

  const budgetUsd = budgetStr !== undefined ? Number(budgetStr) : DEFAULT_BUDGET_USD;
  const expiresMinutes = expiryStr !== undefined ? Number(expiryStr) : DEFAULT_EXPIRY_MIN;

  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    ctx.err(`✘ invalid --budget "${budgetStr}" (must be a positive number)`);
    return 2;
  }
  if (!Number.isFinite(expiresMinutes) || expiresMinutes <= 0) {
    ctx.err(`✘ invalid --expiry "${expiryStr}" (must be a positive number of minutes)`);
    return 2;
  }

  let mgr = manager;
  if (!mgr) {
    try {
      mgr = buildRuntime(ctx, configPath ?? undefined).manager;
    } catch (err) {
      return reportConfigError(err, ctx);
    }
  }

  const input: CreateSessionInput = {
    userId: DEFAULT_USER,
    budgetUsd,
    expiresMinutes,
  };
  const session = await mgr.createPaymentSession(input);

  ctx.log(`✔ created payment session`);
  ctx.log(`  id        ${session.id}`);
  ctx.log(
    `  budget    ${session.budget.amountAtomic} (${session.budget.currency}, ${session.budget.decimals} decimals) ≈ $${budgetUsd}`
  );
  ctx.log(`  expiresAt ${session.expiresAt}`);
  ctx.log(`  status    ${session.status}`);
  return 0;
}

// ============================================================================
//  oap session show <id>
// ============================================================================

export async function cmdSessionShow(
  argv: ReadonlyArray<string>,
  ctx: CommandContext,
  manager?: PaymentManager
): Promise<number> {
  const id = firstPositional(argv, ["--config", "-c"]);
  if (id === undefined) {
    ctx.err("oap session show: missing <id>");
    return 2;
  }
  const configPath = flag(argv, "--config", "-c");

  let mgr = manager;
  if (!mgr) {
    try {
      mgr = buildRuntime(ctx, configPath ?? undefined).manager;
    } catch (err) {
      return reportConfigError(err, ctx);
    }
  }

  const session = await mgr.getPaymentSession(id as SessionId);
  if (!session) {
    ctx.err(`✘ session not found: ${id}`);
    return 5;
  }
  ctx.log(pretty(session));
  return 0;
}

// ============================================================================
//  Helpers
// ============================================================================

function reportConfigError(err: unknown, ctx: CommandContext): number {
  if (err instanceof ConfigError) {
    ctx.err(`✘ ${err.message}`);
    for (const issue of err.issues ?? []) {
      ctx.err(`  - ${issue.path || "(root)"}: ${issue.message}`);
    }
    return 3;
  }
  throw err;
}
