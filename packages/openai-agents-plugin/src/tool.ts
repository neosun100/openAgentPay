/**
 * @openagentpay/openai-agents-plugin
 * ==================================
 *
 * OpenAI Agents SDK function-tool wrapper. The OpenAI Agents SDK
 * (https://openai.github.io/openai-agents-js / openai-agents-python) represents
 * a function tool as:
 *   { name, description, parameters (JSON schema), invoke(args) }
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose an
 * OpenAI-Agents-shaped descriptor. We surface BOTH `invoke` and `execute` so
 * the descriptor drops into the JS SDK (`invoke`) and any caller expecting the
 * generic `execute(args)` handler shape.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type OpenAIAgentsPaymentToolInput = LlamaPaymentToolInput;
export type OpenAIAgentsPaymentToolResult = LlamaPaymentToolResult;
export type CreateOpenAIAgentsPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * OpenAI Agents SDK function-tool descriptor.
 *
 * `type: "function"` and the `{ name, description, parameters }` triple mirror
 * the SDK's FunctionTool. `invoke(args)` is the SDK call entrypoint; `execute`
 * is an alias for generic callers. Both return the structured payment result.
 */
export interface OpenAIAgentsToolDescriptor {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** OpenAI Agents SDK call entrypoint. */
  invoke: (
    args: OpenAIAgentsPaymentToolInput
  ) => Promise<OpenAIAgentsPaymentToolResult>;
  /** Alias for generic function-tool callers. */
  execute: (
    args: OpenAIAgentsPaymentToolInput
  ) => Promise<OpenAIAgentsPaymentToolResult>;
}

const PARAMETERS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    amountUsd: { type: "number", description: "Amount in USD; settles in USDC. Must be > 0." },
    recipient: { type: "string", description: "0x… address, merchant id, or DID." },
    reason: { type: "string", description: "Short reason — logged to audit trail." },
    walletProvider: { type: "string", description: "Optional wallet override (e.g. 'coinbase-cdp')." },
    mandates: {
      type: "array",
      items: { type: "object" },
      description: "Optional AP2 mandate chain (Intent / Cart / Payment VCs).",
    },
  },
  required: ["amountUsd", "recipient", "reason"],
};

/**
 * Build an OpenAI Agents SDK function tool. Plug into the SDK:
 *
 *   import { Agent } from "@openai/agents";
 *   import { createOpenAIAgentsPaymentTool } from "@openagentpay/openai-agents-plugin";
 *   const payTool = createOpenAIAgentsPaymentTool({ manager, governance, ... });
 *   const agent = new Agent({ ..., tools: [payTool] });
 */
export function createOpenAIAgentsPaymentTool(
  cfg: CreateOpenAIAgentsPaymentToolConfig
): OpenAIAgentsToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  const run = (args: OpenAIAgentsPaymentToolInput): Promise<OpenAIAgentsPaymentToolResult> =>
    inner.runPayment(args);
  return {
    type: "function",
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    invoke: run,
    execute: run,
  };
}
