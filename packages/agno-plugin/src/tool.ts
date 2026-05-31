/**
 * @openagentpay/agno-plugin
 * =========================
 *
 * Agno (formerly phidata, https://github.com/agno-agi/agno) function-tool
 * wrapper. Agno toolkits register tools as descriptors of shape:
 *   { name, description, parameters (JSON Schema), entrypoint(args) }
 * where `entrypoint` receives the parsed argument object and returns the
 * result the agent reasons over.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose an
 * Agno-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type AgnoPaymentToolInput = LlamaPaymentToolInput;
export type AgnoPaymentToolResult = LlamaPaymentToolResult;
export type CreateAgnoPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * Agno function-tool descriptor — the shape an Agno Toolkit registers.
 * `entrypoint` receives the parsed args directly and returns the result.
 */
export interface AgnoToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  entrypoint: (args: AgnoPaymentToolInput) => Promise<AgnoPaymentToolResult>;
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
 * Build an Agno-shaped function tool. Plug into an Agno Agent:
 *
 *   import { Agent } from "agno";
 *   import { createAgnoPaymentTool } from "@openagentpay/agno-plugin";
 *   const payTool = createAgnoPaymentTool({ manager, governance, ... });
 *   new Agent({ ..., tools: [payTool] });
 */
export function createAgnoPaymentTool(
  cfg: CreateAgnoPaymentToolConfig
): AgnoToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    entrypoint: async (args: AgnoPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
