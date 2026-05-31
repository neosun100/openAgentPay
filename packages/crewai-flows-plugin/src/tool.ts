/**
 * @openagentpay/crewai-flows-plugin
 * =================================
 *
 * CrewAI Flows tool wrapper. CrewAI's `@tool`-style descriptor (as consumed by
 * the Flows API) has shape:
 *   { name, description, args_schema, run(args) }
 * where `args_schema` is a JSON Schema and `run` receives the parsed arguments
 * directly and returns the result. (Distinct from the base crewai-plugin —
 * this targets the Flows API surface.)
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * CrewAI-Flows-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type CrewAiFlowPaymentToolInput = LlamaPaymentToolInput;
export type CrewAiFlowPaymentToolResult = LlamaPaymentToolResult;
export type CreateCrewAiFlowPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * CrewAI Flows tool descriptor — `@tool`-style object with `args_schema`
 * (JSON Schema) and a `run` that receives parsed args directly.
 */
export interface CrewAiFlowToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly args_schema: Record<string, unknown>;
  run: (args: CrewAiFlowPaymentToolInput) => Promise<CrewAiFlowPaymentToolResult>;
}

const ARGS_JSON_SCHEMA: Record<string, unknown> = {
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
 * Build a CrewAI-Flows-shaped tool. Plug into a CrewAI Flow:
 *
 *   from crewai.flow.flow import Flow, listen, start
 *   # (JS interop) the descriptor exposes name / description / args_schema / run
 *   const payTool = createCrewAiFlowPaymentTool({ manager, governance, ... });
 *   const result = await payTool.run({ amountUsd, recipient, reason });
 */
export function createCrewAiFlowPaymentTool(
  cfg: CreateCrewAiFlowPaymentToolConfig
): CrewAiFlowToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    args_schema: ARGS_JSON_SCHEMA,
    run: async (args: CrewAiFlowPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
