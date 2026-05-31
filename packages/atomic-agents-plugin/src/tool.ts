/**
 * @openagentpay/atomic-agents-plugin
 * ==================================
 *
 * Atomic Agents-style Tool wrapper. Atomic Agents tools are schema-first and
 * expose shape:
 *   { name, description, input_schema, run(args) }
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

export type AtomicPaymentToolInput = LlamaPaymentToolInput;
export type AtomicPaymentToolResult = LlamaPaymentToolResult;
export type CreateAtomicPaymentToolConfig = CreateLlamaPaymentToolConfig;

export interface AtomicAgentsToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  run: (args: AtomicPaymentToolInput) => Promise<AtomicPaymentToolResult>;
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
 * Build an Atomic Agents-shaped tool. Plug into an Atomic Agents agent:
 *
 *   import { createAtomicPaymentTool } from "@openagentpay/atomic-agents-plugin";
 *   const payTool = createAtomicPaymentTool({ manager, governance, ... });
 *   agent.registerTool(payTool);
 */
export function createAtomicPaymentTool(
  cfg: CreateAtomicPaymentToolConfig
): AtomicAgentsToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    input_schema: PARAMETERS_JSON_SCHEMA,
    run: async (args: AtomicPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
