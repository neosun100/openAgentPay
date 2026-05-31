/**
 * @openagentpay/google-adk-plugin
 * ===============================
 *
 * Google ADK (Agent Development Kit, https://google.github.io/adk-docs/)
 * FunctionTool wrapper. An ADK FunctionTool is described by a plain object:
 *   { name, description, parameters (JSON Schema), func(args) }
 * where `func` receives the parsed arguments directly and returns the result.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Google-ADK-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type GoogleAdkPaymentToolInput = LlamaPaymentToolInput;
export type GoogleAdkPaymentToolResult = LlamaPaymentToolResult;
export type CreateGoogleAdkPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * Google ADK FunctionTool descriptor — the exact shape ADK's FunctionTool
 * consumes. `func` receives parsed args directly and returns the result.
 */
export interface GoogleAdkFunctionTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  func: (args: GoogleAdkPaymentToolInput) => Promise<GoogleAdkPaymentToolResult>;
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
 * Build a Google ADK FunctionTool. Plug into ADK:
 *
 *   import { FunctionTool, LlmAgent } from "@google/adk";
 *   import { createGoogleAdkPaymentTool } from "@openagentpay/google-adk-plugin";
 *   const payTool = new FunctionTool(createGoogleAdkPaymentTool({ manager, ... }));
 *   const agent = new LlmAgent({ ..., tools: [payTool] });
 */
export function createGoogleAdkPaymentTool(
  cfg: CreateGoogleAdkPaymentToolConfig
): GoogleAdkFunctionTool {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    func: async (args: GoogleAdkPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
