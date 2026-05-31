/**
 * @openagentpay/agentscope-plugin
 * ===============================
 *
 * AgentScope (https://github.com/modelscope/agentscope) ServiceToolkit wrapper.
 * AgentScope service functions have the shape:
 *   { name, description, parameters, call(args) }
 * where `call` receives the parsed arguments and returns a ServiceResponse-like
 * object: { status: "success" | "error", content }.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose an
 * AgentScope-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type AgentScopePaymentToolInput = LlamaPaymentToolInput;
export type AgentScopePaymentToolResult = LlamaPaymentToolResult;
export type CreateAgentScopePaymentToolConfig = CreateLlamaPaymentToolConfig;

/** AgentScope ServiceResponse status enum (mirrors the Python `ServiceExecStatus`). */
export type AgentScopeServiceStatus = "success" | "error";

/** AgentScope ServiceResponse — what `call` resolves to. */
export interface AgentScopeServiceResponse {
  readonly status: AgentScopeServiceStatus;
  readonly content: AgentScopePaymentToolResult;
}

/**
 * AgentScope service-function descriptor — the shape consumed by
 * `ServiceToolkit.add()`.  `call` receives parsed args and resolves to a
 * ServiceResponse.
 */
export interface AgentScopeToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  call: (args: AgentScopePaymentToolInput) => Promise<AgentScopeServiceResponse>;
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
 * Build an AgentScope-shaped service tool. Plug into AgentScope:
 *
 *   import { ServiceToolkit } from "agentscope";
 *   import { createAgentScopePaymentTool } from "@openagentpay/agentscope-plugin";
 *   const payTool = createAgentScopePaymentTool({ manager, governance, ... });
 *   toolkit.add(payTool);
 */
export function createAgentScopePaymentTool(
  cfg: CreateAgentScopePaymentToolConfig
): AgentScopeToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    parameters: PARAMETERS_JSON_SCHEMA,
    call: async (args: AgentScopePaymentToolInput): Promise<AgentScopeServiceResponse> => {
      const content = await inner.runPayment(args);
      return {
        status: content.success ? "success" : "error",
        content,
      };
    },
  };
}
