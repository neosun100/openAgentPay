/**
 * @openagentpay/mcp-tool-plugin
 * =============================
 *
 * Model Context Protocol (MCP, https://modelcontextprotocol.io) tool wrapper.
 * MCP servers register tools of shape:
 *   { name, description, inputSchema, handler(args) }
 * where `inputSchema` is a JSON Schema and `handler` receives the parsed
 * arguments object and returns the tool result. This is the shape consumed by
 * `server.registerTool(...)` / `setRequestHandler(...)` in the MCP TS SDK.
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose an
 * MCP-shaped descriptor. Any MCP-speaking host can then pay via OpenAgentPay.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type McpPaymentToolInput = LlamaPaymentToolInput;
export type McpPaymentToolResult = LlamaPaymentToolResult;
export type CreateMcpPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * MCP tool descriptor — the exact shape accepted by an MCP server's
 * `registerTool` / tool-registration request handler. `handler` receives the
 * parsed arguments object directly and returns the payment result.
 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  handler: (args: McpPaymentToolInput) => Promise<McpPaymentToolResult>;
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
 * Build an MCP-shaped tool. Register on an MCP server:
 *
 *   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 *   import { createMcpPaymentTool } from "@openagentpay/mcp-tool-plugin";
 *   const payTool = createMcpPaymentTool({ manager, governance, ... });
 *   server.registerTool(payTool.name, {
 *     description: payTool.description,
 *     inputSchema: payTool.inputSchema,
 *   }, payTool.handler);
 */
export function createMcpPaymentTool(
  cfg: CreateMcpPaymentToolConfig
): McpToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    inputSchema: PARAMETERS_JSON_SCHEMA,
    handler: async (args: McpPaymentToolInput) => {
      return inner.runPayment(args);
    },
  };
}
