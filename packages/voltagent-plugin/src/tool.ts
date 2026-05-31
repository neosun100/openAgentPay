/**
 * @openagentpay/voltagent-plugin
 * ==============================
 *
 * VoltAgent-shaped Tool wrapper. VoltAgent (https://voltagent.dev) tools are
 * built via `createTool({ name, description, parameters, execute })` where
 * `parameters` is a Zod-ish/JSON schema and `execute(args)` runs the tool.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * VoltAgent-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type VoltAgentPaymentToolInput = LlamaPaymentToolInput;
export type VoltAgentPaymentToolResult = LlamaPaymentToolResult;
export type CreateVoltAgentPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * VoltAgent tool descriptor — the object returned by `createTool(...)`.
 * `parameters` carries the JSON-schema describing the tool input, and
 * `execute(args)` performs the payment.
 */
export interface VoltAgentToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute: (args: VoltAgentPaymentToolInput) => Promise<VoltAgentPaymentToolResult>;
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
 * Build a VoltAgent-shaped tool. Plug into VoltAgent:
 *
 *   import { Agent } from "@voltagent/core";
 *   import { createVoltAgentPaymentTool } from "@openagentpay/voltagent-plugin";
 *   const payTool = createVoltAgentPaymentTool({ manager, governance, ... });
 *   new Agent({ ..., tools: [payTool] });
 */
export function createVoltAgentPaymentTool(
  cfg: CreateVoltAgentPaymentToolConfig
): VoltAgentToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    execute: async (args: VoltAgentPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
