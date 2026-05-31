/**
 * `oap` CLI binary entrypoint.
 *
 * Tiny dispatcher — no external argv parser dependency. Each subcommand owns
 * its own option parsing inside packages/cli/src/commands/.
 *
 * Usage:
 *   oap config init [--out openagentpay.yaml]
 *   oap config validate [path]
 *   oap config show [path]
 *   oap doctor [path]
 *   oap conformance test [--package <path>]
 *   oap session create [--budget <usd>] [--expiry <minutes>] [--config <path>]
 *   oap session show <id> [--config <path>]
 *   oap pay --to <recipient> --amount <1.5USDC> --wallet <provider> [--session <id>] [--config <path>]
 *   oap version
 *
 * Exit codes:
 *   0    success
 *   1    runtime error (uncaught exception)
 *   2    invalid argv / unknown command
 *   3    config validation failure
 *   4    doctor failed
 *   5    session not found
 *   6    audit file not found / payment failed
 *
 * @license Apache-2.0
 */

import { writeFileSync } from "node:fs";
import { exitWithCode } from "./io.js";
import { commands } from "./commands/index.js";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const VERSION = "0.1.0-alpha";

const HELP = `\
oap — OpenAgentPay CLI

Usage:
  oap <command> [args]

Commands:
  config init [--out FILE]      Write a skeleton openagentpay.yaml
  config validate [PATH]         Validate openagentpay.yaml (default ./openagentpay.yaml)
  config show [PATH]             Pretty-print effective config (with defaults applied)
  doctor [PATH]                  Health check: config + secrets + reachability of declared modules
  conformance test [--pkg DIR]   Run @openagentpay/conformance against a connector package
  audit [--file FILE]            Read & filter an append-only audit log (JSONL)
  session create [--budget USD] [--expiry MIN] [--config PATH]   Mint a payment session
  session show <id> [--config PATH]                              Inspect a payment session
  pay --to ADDR --amount 1.5USDC --wallet PROVIDER [--session ID] [--config PATH]   Execute a payment
  version                        Print version

Examples:
  oap config init --out my.yaml
  oap config validate ./openagentpay.yaml
  oap doctor
  oap conformance test --pkg packages/wallet-hashkey
  oap session create --budget 50 --expiry 120
  oap pay --to 0xRecipient --amount 1.5USDC --wallet hashkey

Issues / docs:
  https://github.com/neosun100/openAgentPay
`;

export async function runCli(argv: ReadonlyArray<string>): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const ctx = {
    log: (s: string) => {
      stdout += s + "\n";
    },
    err: (s: string) => {
      stderr += s + "\n";
    },
    cwd: process.cwd(),
    env: process.env,
  };

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    ctx.log(HELP);
    return { exitCode: 0, stdout, stderr };
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    ctx.log(`oap ${VERSION}`);
    return { exitCode: 0, stdout, stderr };
  }

  const [head, ...rest] = argv;
  const handler = commands[head as keyof typeof commands];
  if (!handler) {
    ctx.err(`oap: unknown command "${head}"`);
    ctx.err(HELP);
    return { exitCode: 2, stdout, stderr };
  }

  try {
    const code = await handler(rest, ctx);
    return { exitCode: code, stdout, stderr };
  } catch (err) {
    ctx.err(`oap: error: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, stdout, stderr };
  }
}

// ---------------------------------------------------------------------------
//  Direct CLI invocation (bin/oap.js)
// ---------------------------------------------------------------------------

const isMainEntry =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("/cli.ts"));

if (isMainEntry) {
  const argv = process.argv.slice(2);
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  runCli(argv).then(({ exitCode, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    exitWithCode(exitCode);
  });
}

// expose for tests
export { writeFileSync };
