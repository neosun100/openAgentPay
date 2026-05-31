/**
 * @openagentpay/llama-stack-plugin
 * ================================
 *
 * Llama Stack (https://github.com/meta-llama/llama-stack) tool wrapper.
 * Llama Stack's tool definitions have shape:
 *   { tool_name, description, parameters, invoke(args) }
 * where `parameters` is a JSON Schema describing the args and `invoke`
 * receives the parsed arguments directly and returns the result.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Llama-Stack-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type LlamaStackPaymentToolInput = LlamaPaymentToolInput;
export type LlamaStackPaymentToolResult = LlamaPaymentToolResult;
export type CreateLlamaStackPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * Llama Stack tool descriptor — the exact shape Llama Stack's agent runtime
 * expects. `invoke` receives parsed args directly (no `{ context }` wrapper).
 */
export interface LlamaStackToolDescriptor {
  readonly tool_name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  invoke: (args: LlamaStackPaymentToolInput) => Promise<LlamaStackPaymentToolResult>;
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
 * Build a Llama-Stack-shaped tool. Plug into Llama Stack:
 *
 *   import { createLlamaStackPaymentTool } from "@openagentpay/llama-stack-plugin";
 *   const payTool = createLlamaStackPaymentTool({ manager, governance, ... });
 *   // register payTool with your Llama Stack agent's tool registry
 *   const result = await payTool.invoke({ amountUsd, recipient, reason });
 */
export function createLlamaStackPaymentTool(
  cfg: CreateLlamaStackPaymentToolConfig
): LlamaStackToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    tool_name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    invoke: async (args: LlamaStackPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
