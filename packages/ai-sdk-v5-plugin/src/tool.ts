/**
 * @openagentpay/ai-sdk-v5-plugin
 * ===============================
 *
 * Vercel AI SDK **v5** tool descriptor. Plugs into `tool()` and the `tools: {}`
 * map of `generateText` / `streamText`.
 *
 * AI SDK v5 changed the tool shape vs v4: the parameter schema field was
 * renamed `parameters` → `inputSchema`, and `execute` receives the validated
 * args object plus a tool-call options bag.
 *
 *   import { tool } from "ai";
 *   tool({
 *     description: string,
 *     inputSchema: ZodSchema | JSONSchema,   // <- v5 renamed from `parameters`
 *     execute: async (args, options) => result,
 *   })
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * framework-neutral `OpenAgentPayLlamaTool` and expose an AI-SDK-v5-shaped
 * descriptor. By default we ship a JSON Schema for `inputSchema`, which the AI
 * SDK accepts directly; pass `inputSchema` in the config to override (e.g. a
 * `zod` schema via `jsonSchema()` / a custom shape).
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type AiSdkV5PaymentToolInput = LlamaPaymentToolInput;
export type AiSdkV5PaymentToolResult = LlamaPaymentToolResult;

/**
 * Config for {@link createAiSdkV5PaymentTool}. Extends the framework-neutral
 * kernel config with an optional `inputSchema` override (AI SDK v5 accepts a
 * Zod schema, a `jsonSchema()` wrapper, or a plain JSON Schema object).
 */
export interface CreateAiSdkV5PaymentToolConfig extends CreateLlamaPaymentToolConfig {
  /** Override the default JSON Schema (e.g. pass a zod schema instead). */
  readonly inputSchema?: unknown;
}

/**
 * The shape `ai@5`'s `tool()` expects. `execute` takes the validated input and
 * a tool-call options bag (toolCallId / messages / abortSignal).
 */
export interface AiSdkV5ToolDescriptor {
  readonly description: string;
  readonly inputSchema: unknown;
  execute: (
    args: AiSdkV5PaymentToolInput,
    options?: {
      readonly toolCallId?: string;
      readonly abortSignal?: AbortSignal;
      readonly messages?: readonly unknown[];
    }
  ) => Promise<AiSdkV5PaymentToolResult>;
}

const DEFAULT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    amountUsd: {
      type: "number",
      description: "Amount in USD. Settles in USDC at 1:1.",
      exclusiveMinimum: 0,
    },
    recipient: {
      type: "string",
      description: "Recipient address or merchant ID.",
      minLength: 1,
    },
    reason: {
      type: "string",
      description: "Why this payment — surfaces in audit log.",
      minLength: 1,
    },
    walletProvider: {
      type: "string",
      description: "Optional wallet override (defaults to plugin config).",
    },
    mandates: {
      type: "array",
      items: { type: "object" },
      description: "Optional AP2 mandate chain.",
    },
  },
  required: ["amountUsd", "recipient", "reason"],
};

/**
 * Build a Vercel AI SDK **v5** tool descriptor. Pass directly into the `tools`
 * map of `generateText` / `streamText`, or wrap with `tool()` for type
 * inference:
 *
 *   import { generateText, tool } from "ai";
 *   import { openai } from "@ai-sdk/openai";
 *   import { createAiSdkV5PaymentTool } from "@openagentpay/ai-sdk-v5-plugin";
 *
 *   const pay = tool(createAiSdkV5PaymentTool({ manager, governance, ... }));
 *   await generateText({ model: openai("gpt-4o-mini"), tools: { pay }, prompt });
 */
export function createAiSdkV5PaymentTool(
  cfg: CreateAiSdkV5PaymentToolConfig
): AiSdkV5ToolDescriptor {
  const { inputSchema, ...kernelCfg } = cfg;
  const inner = new OpenAgentPayLlamaTool(kernelCfg);
  return {
    description: inner.description,
    inputSchema: inputSchema ?? DEFAULT_INPUT_SCHEMA,
    execute: async (
      args: AiSdkV5PaymentToolInput,
      _options?: {
        readonly toolCallId?: string;
        readonly abortSignal?: AbortSignal;
        readonly messages?: readonly unknown[];
      }
    ): Promise<AiSdkV5PaymentToolResult> => {
      return inner.runPayment(args);
    },
  };
}
