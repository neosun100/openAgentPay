/**
 * @openagentpay/smolagents-plugin
 * ===============================
 *
 * HuggingFace smolagents (https://github.com/huggingface/smolagents) Tool
 * wrapper. A smolagents `Tool` has shape:
 *   { name, description, inputs, output_type, forward(args) }
 * where `inputs` is a dict of JSON-schema-ish param descriptors, `output_type`
 * is a smolagents type string ("string", "number", ...) and `forward` receives
 * the parsed arguments directly and returns the result.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * smolagents-shaped descriptor. The JS-facing shape mirrors smolagents but uses
 * camelCase `outputType` and `forward` for ergonomic TS consumption.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type SmolagentsPaymentToolInput = LlamaPaymentToolInput;
export type SmolagentsPaymentToolResult = LlamaPaymentToolResult;
export type CreateSmolagentsPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * smolagents per-input descriptor. Each entry in `inputs` is a JSON-schema-ish
 * dict with at least `type` + `description`; optional inputs add `nullable`.
 */
export interface SmolagentsInputSpec {
  readonly type: string;
  readonly description: string;
  readonly nullable?: boolean;
}

/**
 * smolagents Tool descriptor — the shape smolagents expects, adapted for TS.
 * `forward` receives parsed args directly and returns the result.
 */
export interface SmolagentsToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputs: Record<string, SmolagentsInputSpec>;
  readonly outputType: "string";
  forward: (args: SmolagentsPaymentToolInput) => Promise<SmolagentsPaymentToolResult>;
}

const INPUTS: Record<string, SmolagentsInputSpec> = {
  amountUsd: {
    type: "number",
    description: "Amount in USD (settles in USDC). Must be > 0.",
  },
  recipient: {
    type: "string",
    description: "Recipient (0x… address, merchant id, or DID).",
  },
  reason: {
    type: "string",
    description: "Short human-readable reason — logged to the audit trail.",
  },
  walletProvider: {
    type: "string",
    description:
      "Optional wallet override (e.g., 'coinbase-cdp', 'hashkey-chain'). Default: agent's configured wallet.",
    nullable: true,
  },
  mandates: {
    type: "array",
    description: "Optional AP2 Verifiable Credential mandate chain.",
    nullable: true,
  },
};

/**
 * Build a smolagents-shaped tool. Plug into smolagents (Python bridge / JS host):
 *
 *   import { createSmolagentsPaymentTool } from "@openagentpay/smolagents-plugin";
 *   const payTool = createSmolagentsPaymentTool({ manager, governance, ... });
 *   // payTool.forward({ amountUsd, recipient, reason }) → Promise<result>
 */
export function createSmolagentsPaymentTool(
  cfg: CreateSmolagentsPaymentToolConfig
): SmolagentsToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    inputs: INPUTS,
    outputType: "string",
    forward: async (args: SmolagentsPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
