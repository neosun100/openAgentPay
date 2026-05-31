/**
 * @openagentpay/spinai-plugin
 * ===========================
 *
 * SpinAI-shaped Action wrapper. SpinAI (https://spinai.dev) actions are built
 * with `createAction({ id, description, parameters, run(parameters) })`, where
 * `run` receives the validated parameters object directly and returns a result.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * SpinAI-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type SpinAiPaymentActionInput = LlamaPaymentToolInput;
export type SpinAiPaymentActionResult = LlamaPaymentToolResult;
export type CreateSpinAiPaymentActionConfig = CreateLlamaPaymentToolConfig;

/**
 * SpinAI action descriptor. Mirrors the shape produced by SpinAI's
 * `createAction({ id, description, parameters, run })`.
 */
export interface SpinAiActionDescriptor {
  readonly id: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  run: (parameters: SpinAiPaymentActionInput) => Promise<SpinAiPaymentActionResult>;
}

const PARAMETERS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    amountUsd: { type: "number", description: "Amount in USD; settles in USDC." },
    recipient: { type: "string", description: "0x… address or merchant id." },
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
 * Build a SpinAI-shaped payment action. Plug into a SpinAI agent:
 *
 *   import { createAgent } from "spinai";
 *   import { createSpinAiPaymentAction } from "@openagentpay/spinai-plugin";
 *   const payAction = createSpinAiPaymentAction({ manager, governance, ... });
 *   const agent = createAgent({ ..., actions: [payAction] });
 */
export function createSpinAiPaymentAction(
  cfg: CreateSpinAiPaymentActionConfig
): SpinAiActionDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    id: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    run: async (parameters: SpinAiPaymentActionInput) => {
      return inner.runPayment(parameters);
    },
  };
}
