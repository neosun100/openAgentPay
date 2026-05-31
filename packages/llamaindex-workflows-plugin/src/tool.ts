/**
 * @openagentpay/llamaindex-workflows-plugin
 * =========================================
 *
 * LlamaIndex **Workflows** step-tool wrapper. Distinct from the base
 * @openagentpay/llamaindex-plugin: this targets the event-driven Workflows API
 * (https://docs.llamaindex.ai/en/stable/module_guides/workflow/), where a step
 * is described by:
 *   { name, description, parameters, handler(ev) }
 * and `handler` receives a workflow *event* carrying the parsed arguments and
 * returns the result that flows to the next step.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Workflows-step-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type LlamaIndexWorkflowPaymentInput = LlamaPaymentToolInput;
export type LlamaIndexWorkflowPaymentResult = LlamaPaymentToolResult;
export type CreateLlamaIndexWorkflowPaymentStepConfig = CreateLlamaPaymentToolConfig;

/**
 * A LlamaIndex Workflows step event. The Workflows runtime hands each step a
 * typed event object; we read the payment arguments straight off it (an event
 * either *is* the input shape or carries it under `.data`).
 */
export type LlamaIndexWorkflowEvent =
  | LlamaIndexWorkflowPaymentInput
  | { readonly data: LlamaIndexWorkflowPaymentInput };

/**
 * Workflows step descriptor — the shape the Workflows API consumes:
 * `{ name, description, parameters, handler(ev) }`.
 */
export interface LlamaIndexWorkflowStepDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  handler: (
    ev: LlamaIndexWorkflowEvent
  ) => Promise<LlamaIndexWorkflowPaymentResult>;
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

/** Normalize a workflow event into the payment input the kernel expects. */
function readInput(ev: LlamaIndexWorkflowEvent): LlamaIndexWorkflowPaymentInput {
  return "data" in ev ? ev.data : ev;
}

/**
 * Build a LlamaIndex Workflows payment step. Wire into a Workflow:
 *
 *   import { Workflow } from "@llamaindex/workflow";
 *   import { createLlamaIndexWorkflowPaymentStep } from "@openagentpay/llamaindex-workflows-plugin";
 *   const payStep = createLlamaIndexWorkflowPaymentStep({ manager, governance, ... });
 *   workflow.addStep({ inputs: [PayEvent], outputs: [DoneEvent] }, payStep.handler);
 */
export function createLlamaIndexWorkflowPaymentStep(
  cfg: CreateLlamaIndexWorkflowPaymentStepConfig
): LlamaIndexWorkflowStepDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    handler: async (ev: LlamaIndexWorkflowEvent) => {
      return inner.runPayment(readInput(ev));
    },
  };
}
