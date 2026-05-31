/**
 * @openagentpay/dspy-plugin
 * =========================
 *
 * DSPy (https://dspy.ai) Tool wrapper. DSPy is a Python framework; here we
 * expose a JS-facing descriptor for parity / cross-language tool registries.
 * A DSPy `Tool` has shape:
 *   { name, description, input signature (JSON schema), forward(args) }
 * where `forward(args)` receives the parsed argument object and returns the
 * tool result (DSPy's synchronous-by-name entrypoint; we keep it async since
 * settlement is I/O-bound).
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * DSPy-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type DspyPaymentToolInput = LlamaPaymentToolInput;
export type DspyPaymentToolResult = LlamaPaymentToolResult;
export type CreateDspyPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * DSPy tool descriptor — mirrors `dspy.Tool`. The `inputSignature` is a JSON
 * Schema describing the args object that `forward` receives.
 */
export interface DspyToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSignature: Record<string, unknown>;
  forward: (args: DspyPaymentToolInput) => Promise<DspyPaymentToolResult>;
}

const INPUT_SIGNATURE_JSON_SCHEMA: Record<string, unknown> = {
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
 * Build a DSPy-shaped tool. Register with a DSPy ReAct/Agent module:
 *
 *   # (Python side, conceptually)
 *   # dspy.ReAct(signature, tools=[pay_tool])
 *
 *   import { createDspyPaymentTool } from "@openagentpay/dspy-plugin";
 *   const payTool = createDspyPaymentTool({ manager, governance, ... });
 *   const result = await payTool.forward({ amountUsd: 1, recipient: "0x…", reason: "api" });
 */
export function createDspyPaymentTool(
  cfg: CreateDspyPaymentToolConfig
): DspyToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    inputSignature: INPUT_SIGNATURE_JSON_SCHEMA,
    forward: async (args: DspyPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
