/**
 * @openagentpay/instructor-js-plugin
 * ===================================
 *
 * Instructor-JS (https://instructor-ai.github.io/instructor-js/) function-tool
 * wrapper. Instructor-JS works against the OpenAI tool-calling shape, so a
 * payment tool is an OpenAI-style function tool:
 *   { type: "function", function: { name, description, parameters } }
 * paired with an `execute(args)` runner that the agent loop invokes once the
 * model returns a tool call.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose an
 * Instructor-JS / OpenAI-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type InstructorPaymentToolInput = LlamaPaymentToolInput;
export type InstructorPaymentToolResult = LlamaPaymentToolResult;
export type CreateInstructorPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * OpenAI-style function-tool definition consumed by Instructor-JS / the
 * OpenAI Chat Completions `tools` array.
 */
export interface InstructorFunctionDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * Instructor-JS payment tool descriptor.
 *
 * `type` + `function` is the exact object you drop into the model's `tools`
 * array; `execute(args)` is the runner the agent loop calls with the parsed
 * tool-call arguments.
 */
export interface InstructorPaymentTool {
  readonly type: "function";
  readonly function: InstructorFunctionDefinition;
  execute: (args: InstructorPaymentToolInput) => Promise<InstructorPaymentToolResult>;
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
 * Build an Instructor-JS / OpenAI-shaped payment tool. Plug into a chat loop:
 *
 *   import OpenAI from "openai";
 *   import Instructor from "@instructor-ai/instructor";
 *   import { createInstructorPaymentTool } from "@openagentpay/instructor-js-plugin";
 *
 *   const payTool = createInstructorPaymentTool({ manager, governance, ... });
 *   const client = Instructor({ client: new OpenAI(), mode: "TOOLS" });
 *   const completion = await client.chat.completions.create({
 *     model: "gpt-4o",
 *     messages,
 *     tools: [{ type: payTool.type, function: payTool.function }],
 *   });
 *   // when the model calls openagentpay_pay:
 *   const result = await payTool.execute(JSON.parse(toolCall.function.arguments));
 */
export function createInstructorPaymentTool(
  cfg: CreateInstructorPaymentToolConfig
): InstructorPaymentTool {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    type: "function",
    function: {
      name: "openagentpay_pay",
      description: inner.description,
      parameters: PARAMETERS_JSON_SCHEMA,
    },
    execute: async (args: InstructorPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
