/**
 * @openagentpay/inngest-agentkit-plugin
 * =====================================
 *
 * Inngest AgentKit-shaped Tool wrapper. AgentKit (https://agentkit.inngest.com)
 * tools have shape:
 *   { name, description, parameters, handler(input, opts) }
 *
 * pydantic-graph is Python-only (it ships with pydantic-ai), so it is NOT a
 * genuine TypeScript agent framework. We instead target Inngest AgentKit — a
 * real, actively-maintained TS-first agent framework — and expose an
 * AgentKit-shaped descriptor with a `handler(args)` entry point.
 *
 * All payment heavy-lifting is delegated to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (framework-neutral kernel). Zero reimplemented logic.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type InngestPaymentToolInput = LlamaPaymentToolInput;
export type InngestPaymentToolResult = LlamaPaymentToolResult;
export type CreateInngestPaymentToolConfig = CreateLlamaPaymentToolConfig;

export interface InngestAgentKitToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  handler: (args: InngestPaymentToolInput) => Promise<InngestPaymentToolResult>;
}

const PARAMETERS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    amountUsd: { type: "number", description: "Amount in USD; settles in USDC." },
    recipient: { type: "string", description: "0x… address, merchant id, or DID." },
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
 * Build an Inngest AgentKit-shaped tool. Plug into AgentKit:
 *
 *   import { createAgent } from "@inngest/agent-kit";
 *   import { createInngestPaymentTool } from "@openagentpay/inngest-agentkit-plugin";
 *   const payTool = createInngestPaymentTool({ manager, governance, ... });
 *   createAgent({ ..., tools: [payTool] });
 */
export function createInngestPaymentTool(
  cfg: CreateInngestPaymentToolConfig
): InngestAgentKitToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    handler: async (args: InngestPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
