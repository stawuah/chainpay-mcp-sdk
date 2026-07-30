import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { callTool, createDefaultContext, TOOL_DEFINITIONS } from "./index.js";
import type { ChainPayMcpContext } from "./tools/context.js";

const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"] as const;
const DEFAULT_MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function negotiateProtocolVersion(params: Record<string, unknown> | undefined): string {
  const requested = params?.protocolVersion;
  if (typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested as typeof MCP_PROTOCOL_VERSIONS[number])) {
    return requested;
  }
  return DEFAULT_MCP_PROTOCOL_VERSION;
}

export function createMcpServer(context: ChainPayMcpContext) {
  return {
    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      const id = request.id ?? null;

      if (request.method.startsWith("notifications/")) return null;

      try {
        switch (request.method) {
          case "initialize":
            return success(id, {
              protocolVersion: negotiateProtocolVersion(request.params),
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "chainpay-mcp", version: "0.1.0" },
              instructions: "ChainPay prepares and routes policy-controlled Solana payments. Wallet signatures and signer adapters remain outside MCP.",
            });
          case "ping":
            return success(id, {});
          case "tools/list":
            return success(id, { tools: TOOL_DEFINITIONS });
          case "tools/call": {
            const params = request.params ?? {};
            const name = params.name;
            if (typeof name !== "string" || name.length === 0) {
              return failure(id, -32602, "tools/call requires a tool name");
            }
            const result = await callTool(context, name, objectArguments(params.arguments));
            return success(id, result);
          }
          default:
            return failure(id, -32601, `Method not found: ${request.method}`);
        }
      } catch (error) {
        return failure(
          id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

export async function runStdioServer(context: ChainPayMcpContext = createDefaultContext()): Promise<void> {
  const server = createMcpServer(context);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of input) {
    if (!line.trim()) continue;
    let response: JsonRpcResponse | null;
    try {
      response = await server.handle(JSON.parse(line) as JsonRpcRequest);
    } catch (error) {
      response = failure(null, -32700, error instanceof Error ? error.message : String(error));
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
