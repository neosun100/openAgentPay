/**
 * Subcommand registry — wires every `oap <cmd>` to its handler.
 *
 * @license Apache-2.0
 */

import type { CommandContext } from "../io.js";
import { cmdConfigValidate, cmdConfigInit, cmdConfigShow } from "./config.js";
import { cmdDoctor } from "./doctor.js";
import { cmdConformance } from "./conformance.js";
import { cmdAudit } from "./audit.js";
import { cmdSessionCreate, cmdSessionShow } from "./session.js";
import { cmdPay } from "./pay.js";

export type Command = (
  argv: ReadonlyArray<string>,
  ctx: CommandContext
) => Promise<number>;

export type { CommandContext };

// `config` is a multi-subcommand group — dispatch on argv[0]
const cmdConfig: Command = async (argv, ctx) => {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "validate":
      return cmdConfigValidate(rest, ctx);
    case "init":
      return cmdConfigInit(rest, ctx);
    case "show":
      return cmdConfigShow(rest, ctx);
    case undefined:
    case "":
      ctx.err("oap config: missing subcommand (validate | init | show)");
      return 2;
    default:
      ctx.err(`oap config: unknown subcommand "${sub}"`);
      return 2;
  }
};

const cmdConformanceGroup: Command = async (argv, ctx) => {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "test":
      return cmdConformance(rest, ctx);
    case undefined:
    case "":
      ctx.err("oap conformance: missing subcommand (test)");
      return 2;
    default:
      ctx.err(`oap conformance: unknown subcommand "${sub}"`);
      return 2;
  }
};

const cmdSession: Command = async (argv, ctx) => {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "create":
      return cmdSessionCreate(rest, ctx);
    case "show":
      return cmdSessionShow(rest, ctx);
    case undefined:
    case "":
      ctx.err("oap session: missing subcommand (create | show)");
      return 2;
    default:
      ctx.err(`oap session: unknown subcommand "${sub}"`);
      return 2;
  }
};

const cmdVersion: Command = async (_argv, ctx) => {
  ctx.log("oap 0.1.0-alpha");
  return 0;
};

export const commands = {
  config: cmdConfig,
  doctor: cmdDoctor,
  conformance: cmdConformanceGroup,
  audit: cmdAudit,
  session: cmdSession,
  pay: cmdPay,
  version: cmdVersion,
} as const;

// re-export individual command functions for the library API
export {
  cmdConfigValidate,
  cmdConfigInit,
  cmdConfigShow,
  cmdDoctor,
  cmdConformance,
  cmdAudit,
  cmdSessionCreate,
  cmdSessionShow,
  cmdPay,
  cmdVersion,
};
