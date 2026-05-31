/**
 * @openagentpay/motia-plugin
 * ==========================
 *
 * Motia (https://motia.dev) step wrapper. Motia is an event-driven backend
 * framework where units of work are "Steps". A step is a plain object of shape:
 *   { name, description, inputSchema, handler(input, ctx) }
 * The `handler` receives the parsed input plus a framework-provided context
 * (logger, emit, state, traceId, …) and returns the result.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Motia-shaped step descriptor. The `ctx` argument is intentionally opaque so
 * this plugin carries no hard dependency on Motia's runtime types.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type MotiaPaymentStepInput = LlamaPaymentToolInput;
export type MotiaPaymentStepResult = LlamaPaymentToolResult;
export type CreateMotiaPaymentStepConfig = CreateLlamaPaymentToolConfig;

/**
 * Motia step context — opaque on purpose. Motia injects a runtime context
 * (logger, emit, state, traceId, …); we accept it without constraining its
 * shape so the plugin needs no `@motiadev/core` peer dependency.
 */
export type MotiaStepContext = Record<string, unknown>;

/**
 * Motia step descriptor — the exact shape Motia's step loader consumes.
 * `handler` receives the parsed input first and the runtime context second,
 * mirroring Motia's `handler(input, ctx)` signature.
 */
export interface MotiaStepDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  handler: (
    input: MotiaPaymentStepInput,
    ctx?: MotiaStepContext
  ) => Promise<MotiaPaymentStepResult>;
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
 * Build a Motia-shaped payment step. Plug into a Motia workflow:
 *
 *   import { createMotiaPaymentStep } from "@openagentpay/motia-plugin";
 *   export const config = { type: "event", subscribes: ["pay.requested"] };
 *   const step = createMotiaPaymentStep({ manager, governance, ... });
 *   export const handler = step.handler;
 */
export function createMotiaPaymentStep(
  cfg: CreateMotiaPaymentStepConfig
): MotiaStepDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    inputSchema: PARAMETERS_JSON_SCHEMA,
    handler: async (
      input: MotiaPaymentStepInput,
      _ctx?: MotiaStepContext
    ): Promise<MotiaPaymentStepResult> => {
      return inner.runPayment(input);
    },
  };
}
