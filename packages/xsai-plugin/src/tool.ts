/**
 * @openagentpay/xsai-plugin
 * =========================
 *
 * xsAI (extra-small AI, https://xsai.js.org) tool wrapper. xsAI's `tool()`
 * helper consumes a plain tool object of shape:
 *   { name, description, parameters, execute(input) }
 * where `parameters` is a JSON Schema and `execute` receives the parsed
 * arguments directly and returns the result.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose an
 * xsAI-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type XsaiPaymentToolInput = LlamaPaymentToolInput;
export type XsaiPaymentToolResult = LlamaPaymentToolResult;
export type CreateXsaiPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * xsAI tool descriptor — the exact shape accepted by xsai's `tool()` helper.
 * `execute` receives parsed args directly (no `{ context }` wrapper).
 */
export interface XsaiToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute: (input: XsaiPaymentToolInput) => Promise<XsaiPaymentToolResult>;
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
 * Build an xsAI-shaped tool. Plug into xsAI:
 *
 *   import { tool, generateText } from "xsai";
 *   import { createXsaiPaymentTool } from "@openagentpay/xsai-plugin";
 *   const payTool = await tool(createXsaiPaymentTool({ manager, governance, ... }));
 *   await generateText({ ..., tools: [payTool] });
 */
export function createXsaiPaymentTool(
  cfg: CreateXsaiPaymentToolConfig
): XsaiToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    execute: async (input: XsaiPaymentToolInput) => {
      return inner.runPayment(input);
    },
  };
}
