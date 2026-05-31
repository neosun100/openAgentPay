/**
 * @openagentpay/openai-swarm-plugin
 * =================================
 *
 * OpenAI Swarm (https://github.com/openai/swarm) tool wrapper. Swarm models a
 * tool as a plain Python function whose signature defines the parameters; the
 * agent's `functions` list is just a collection of callables. Ported to JS, the
 * equivalent is a plain function descriptor of shape:
 *   { name, description, parameters, run(args) }
 * where `parameters` is a JSON Schema (Swarm derives this from the Python
 * signature) and `run` receives the parsed arguments object directly and
 * returns the result.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Swarm-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type SwarmPaymentToolInput = LlamaPaymentToolInput;
export type SwarmPaymentToolResult = LlamaPaymentToolResult;
export type CreateSwarmPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * OpenAI Swarm tool descriptor — a plain function exposed as a JS descriptor.
 * `run` receives parsed args directly (mirrors a Swarm Python function call).
 */
export interface SwarmToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  run: (args: SwarmPaymentToolInput) => Promise<SwarmPaymentToolResult>;
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
 * Build an OpenAI Swarm-shaped tool. Plug into Swarm:
 *
 *   from swarm import Agent
 *   # (JS-side) build descriptor, expose `run` as the callable Swarm invokes:
 *   const payTool = createSwarmPaymentTool({ manager, governance, ... });
 *   // agent.functions = [payTool.run]  // Swarm calls run(args)
 */
export function createSwarmPaymentTool(
  cfg: CreateSwarmPaymentToolConfig
): SwarmToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    run: async (args: SwarmPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
