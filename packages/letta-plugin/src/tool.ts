/**
 * @openagentpay/letta-plugin
 * ==========================
 *
 * Letta (MemGPT, https://docs.letta.com) tool wrapper. Letta tools are plain
 * objects with shape:
 *   { name, description, json_schema, execute(args) }
 * where `json_schema` is a JSON Schema (OpenAI function-calling style) and
 * `execute` receives the parsed arguments object directly.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Letta-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type LettaPaymentToolInput = LlamaPaymentToolInput;
export type LettaPaymentToolResult = LlamaPaymentToolResult;
export type CreateLettaPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * Letta tool descriptor — the shape Letta's tool registry consumes.
 * `json_schema` follows OpenAI function-calling conventions (name + parameters);
 * `execute` receives parsed args directly and returns the structured result.
 */
export interface LettaToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly json_schema: Record<string, unknown>;
  execute: (args: LettaPaymentToolInput) => Promise<LettaPaymentToolResult>;
}

const PARAMETERS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    amountUsd: { type: "number", description: "Amount in USD; settles in USDC." },
    recipient: { type: "string", description: "0x… or merchant id." },
    reason: { type: "string", description: "Audit-log reason." },
    walletProvider: { type: "string", description: "Optional wallet override." },
    mandates: {
      type: "array",
      items: { type: "object" },
      description: "Optional AP2 mandate chain.",
    },
  },
  required: ["amountUsd", "recipient", "reason"],
};

/**
 * Build a Letta-shaped tool. Plug into Letta:
 *
 *   import { createLettaPaymentTool } from "@openagentpay/letta-plugin";
 *   const payTool = createLettaPaymentTool({ manager, governance, ... });
 *   // register payTool with your Letta agent's tool set; Letta calls
 *   // payTool.execute(args) with the parsed function-call arguments.
 */
export function createLettaPaymentTool(
  cfg: CreateLettaPaymentToolConfig
): LettaToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    json_schema: {
      name: "openagentpay_pay",
      description: inner.description,
      parameters: PARAMETERS_JSON_SCHEMA,
    },
    execute: async (args: LettaPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
