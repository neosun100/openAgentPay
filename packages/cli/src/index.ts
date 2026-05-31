/**
 * @openagentpay/cli — public entry point.
 *
 * Library-style API surface for embedding the CLI's commands in another tool.
 * The actual binary is `cli.ts` which parses argv and dispatches.
 *
 * @license Apache-2.0
 */

export { runCli, type CliResult } from "./cli.js";
export {
  cmdConfigValidate,
  cmdConfigInit,
  cmdConfigShow,
  cmdDoctor,
  cmdConformance,
  cmdSessionCreate,
  cmdSessionShow,
  cmdPay,
  cmdVersion,
  type Command,
  type CommandContext,
} from "./commands/index.js";
export { parseAmount, AmountParseError, DEFAULT_DECIMALS } from "./commands/amount.js";
