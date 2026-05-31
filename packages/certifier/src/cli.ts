/**
 * certifier-cli — emit a signed ConformanceCertificate from CLI args
 * ==================================================================
 *
 * External repos run their conformance suite (e.g. `vitest run`), capture the
 * passed/total counts, then invoke this bin to mint a verifiable certificate:
 *
 *   certifier-cli --subject @acme/wallet-foo --kind wallet --passed 25 --total 25
 *
 * On success it prints a signed {@link ConformanceCertificate} JSON to stdout
 * and exits 0. If the run is NOT all-passed (or args are invalid) it prints a
 * diagnostic to stderr and exits non-zero — so CI gates fail loudly.
 *
 * @license Apache-2.0
 */

import {
  type ConformanceResult,
  issueCertificate,
  signCertificateHmac,
} from "./certificate.js";

export interface CliResult {
  /** Process exit code: 0 on success, non-zero on failure. */
  readonly code: number;
  /** Text written to stdout (the signed cert JSON on success). */
  readonly stdout: string;
  /** Diagnostic written to stderr on failure. */
  readonly stderr: string;
}

const USAGE =
  "Usage: certifier-cli --subject <pkg> --kind <wallet|protocol> --passed <N> --total <N> [--skipped <N>] [--secret <hmac>] [--issuer <id>]";

/** Parse `--flag value` style argv into a map. Unknown/odd args are tolerated. */
export function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok !== undefined && tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function parseCount(raw: string | undefined, name: string): number {
  if (raw === undefined) {
    throw new Error(`missing required --${name}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

/**
 * Pure entrypoint — returns a {@link CliResult} instead of touching the
 * process, so it can be unit-tested without spawning a shell.
 */
export function runCli(argv: readonly string[]): CliResult {
  try {
    const args = parseArgs(argv);

    const subject = args["subject"];
    if (subject === undefined || subject.trim().length === 0) {
      return { code: 2, stdout: "", stderr: `missing required --subject\n${USAGE}` };
    }

    const kind = args["kind"];
    if (kind !== "wallet" && kind !== "protocol") {
      return {
        code: 2,
        stdout: "",
        stderr: `--kind must be "wallet" or "protocol" (got "${kind ?? ""}")\n${USAGE}`,
      };
    }

    const passed = parseCount(args["passed"], "passed");
    const total = parseCount(args["total"], "total");
    const skipped = args["skipped"] !== undefined ? parseCount(args["skipped"], "skipped") : 0;

    const allPassed = passed + skipped === total && passed > 0;
    const result: ConformanceResult = { passed, skipped, total, allPassed };

    if (!allPassed) {
      return {
        code: 1,
        stdout: "",
        stderr: `conformance NOT all-passed for ${subject}: passed=${passed} skipped=${skipped} total=${total} — no certificate issued`,
      };
    }

    const issuer = args["issuer"] ?? "certifier-cli";
    const cert = issueCertificate({ subject, subjectKind: kind, result, issuer });

    const secret = args["secret"];
    const finalCert =
      secret !== undefined && secret.length > 0 ? signCertificateHmac(cert, secret) : cert;

    return { code: 0, stdout: JSON.stringify(finalCert, null, 2), stderr: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 2, stdout: "", stderr: `${message}\n${USAGE}` };
  }
}

/* c8 ignore start — thin process shim, exercised via runCli in tests. */
function main(): void {
  const res = runCli(process.argv.slice(2));
  if (res.stdout.length > 0) process.stdout.write(res.stdout + "\n");
  if (res.stderr.length > 0) process.stderr.write(res.stderr + "\n");
  process.exit(res.code);
}

const invokedDirectly =
  process.argv[1] !== undefined && /certifier-cli|cli\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main();
}
/* c8 ignore stop */
