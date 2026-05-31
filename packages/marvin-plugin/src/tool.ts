/**
 * @openagentpay/marvin-plugin
 * ===========================
 *
 * Marvin-style ai_fn descriptor. Marvin (https://askmarvin.ai) models tools as
 * declarative AI functions; we mirror that with shape:
 *   { name, description, parameters, fn(args) }
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

export type MarvinPaymentToolInput = LlamaPaymentToolInput;
export type MarvinPaymentToolResult = LlamaPaymentToolResult;
export type CreateMarvinPaymentToolConfig = CreateLlamaPaymentToolConfig;

export interface MarvinAiFnDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  fn: (args: MarvinPaymentToolInput) => Promise<MarvinPaymentToolResult>;
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
 * Build a Marvin-style ai_fn descriptor. Register with a Marvin agent:
 *
 *   import { createMarvinPaymentFn } from "@openagentpay/marvin-plugin";
 *   const payFn = createMarvinPaymentFn({ manager, governance, ... });
 *   agent.use(payFn);
 */
export function createMarvinPaymentFn(
  cfg: CreateMarvinPaymentToolConfig
): MarvinAiFnDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    fn: async (args: MarvinPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
