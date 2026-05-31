/**
 * @openagentpay/cloudflare-agents-plugin
 * ======================================
 *
 * Cloudflare Agents SDK (https://developers.cloudflare.com/agents/) tool
 * wrapper. The Agents SDK's `tool()` helper consumes a Workers-compatible
 * tool object of shape:
 *   { description, parameters, execute(args) }
 * where `parameters` is a JSON Schema and `execute` receives the parsed
 * arguments directly and returns the result (runs inside a Durable Object).
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Cloudflare-Agents-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type CloudflareAgentsPaymentToolInput = LlamaPaymentToolInput;
export type CloudflareAgentsPaymentToolResult = LlamaPaymentToolResult;
export type CreateCloudflareAgentsPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * Cloudflare Agents tool descriptor — the exact shape accepted by the Agents
 * SDK's `tool()` helper. `execute` receives parsed args directly and is
 * Workers/Durable-Object safe (no Node-only APIs).
 */
export interface CloudflareAgentsToolDescriptor {
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute: (
    args: CloudflareAgentsPaymentToolInput
  ) => Promise<CloudflareAgentsPaymentToolResult>;
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
 * Build a Cloudflare-Agents-shaped tool. Plug into the Agents SDK:
 *
 *   import { tool } from "agents";
 *   import { createCloudflareAgentsPaymentTool } from "@openagentpay/cloudflare-agents-plugin";
 *   const pay = tool(createCloudflareAgentsPaymentTool({ manager, governance, ... }));
 *   // expose `pay` from your Agent's tool set
 */
export function createCloudflareAgentsPaymentTool(
  cfg: CreateCloudflareAgentsPaymentToolConfig
): CloudflareAgentsToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    execute: async (args: CloudflareAgentsPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
