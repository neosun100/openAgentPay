/**
 * @openagentpay/pydantic-graph-plugin
 * ===================================
 *
 * Pydantic Graph (https://ai.pydantic.dev/graph/) node-tool wrapper. In a
 * Pydantic Graph the unit of work is a node that runs with a graph context
 * (state + dependencies). We model the payment capability as a node-shaped
 * tool of shape:
 *   { name, description, parameters, run(ctx, args) }
 * where `run` receives the graph context (ignored for the payment itself)
 * plus the parsed arguments and delegates straight to the kernel.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Pydantic-Graph-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type PydanticGraphPaymentToolInput = LlamaPaymentToolInput;
export type PydanticGraphPaymentToolResult = LlamaPaymentToolResult;
export type CreatePydanticGraphPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * Pydantic-Graph-shaped node-tool descriptor.
 *
 * `run` mirrors a Pydantic Graph node's `run(ctx, args)` signature: the first
 * argument is the graph run context (state/deps — ignored for the payment),
 * the second is the parsed tool arguments. The payment is fully driven by
 * `args`, so `ctx` is accepted but unused.
 */
export interface PydanticGraphToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  run: (
    ctx: unknown,
    args: PydanticGraphPaymentToolInput
  ) => Promise<PydanticGraphPaymentToolResult>;
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
 * Build a Pydantic-Graph-shaped node-tool. Use inside a graph node's `run`:
 *
 *   import { createPydanticGraphPaymentTool } from "@openagentpay/pydantic-graph-plugin";
 *   const payTool = createPydanticGraphPaymentTool({ manager, governance, ... });
 *   // inside a node: async run(ctx) { return payTool.run(ctx, args); }
 */
export function createPydanticGraphPaymentTool(
  cfg: CreatePydanticGraphPaymentToolConfig
): PydanticGraphToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    run: async (_ctx: unknown, args: PydanticGraphPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
