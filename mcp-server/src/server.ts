import { pathToFileURL } from "node:url";
import { AuthorizationError } from "./authorization.js";
import { callTool, createDefaultContext, TOOL_DEFINITIONS } from "./index.js";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  SERVER_INFO,
  authorizationHttpStatus,
  classifyProtocol,
  decorateModernResult,
  jsonRpcFailure,
  jsonRpcSuccess,
  listedToolDefinitions,
  modernDiscoverResult,
  modernToolsListResult,
  negotiateLegacyProtocolVersion,
  objectArguments,
  parseErrorResponse,
  parseJsonRpcMessage,
  responseId,
  toolExecutionError,
  type JsonRpcId,
  type JsonRpcResponse,
  type ProtocolClassification,
  type RequestId,
  type ValidatedMessage,
  MAX_MCP_BYTES,
} from "./protocol.js";
import type { ChainPayMcpContext } from "./tools/context.js";
import process from "node:process";

export {
  CURRENT_PROTOCOL_VERSION,
  SERVER_INFO,
  parseJsonRpcMessage,
  decodeMcpNameHeader,
  classifyProtocol,
  validateModernHttpRequest,
  jsonRpcHttpStatus,
  jsonRpcFailure,
  jsonRpcSuccess,
  parseErrorResponse,
  HEADER_MISMATCH,
  UNSUPPORTED_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
  modernDiscoverResult,
} from "./protocol.js";
export type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

const LEGACY_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);
const MODERN_METHODS = new Set(["server/discover", "tools/list", "tools/call"]);
const MAX_STDIO_IN_FLIGHT = 32;

export type HandleOptions = {
  signal?: AbortSignal;
  transport?: "http" | "stdio" | "direct";
  headerVersion?: string;
  cancelled?: (id: RequestId) => boolean;
};

function knownTool(name: string): boolean {
  return TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

function isCancelled(options: HandleOptions | undefined, id: RequestId | undefined): boolean {
  if (options?.signal?.aborted) return true;
  if (id !== undefined && options?.cancelled?.(id)) return true;
  return false;
}

async function callNamedTool(
  context: ChainPayMcpContext,
  name: string,
  args: Record<string, unknown>,
  era: ProtocolClassification["era"],
  id: JsonRpcId | undefined,
) {
  if (!knownTool(name)) {
    return jsonRpcFailure(id, INVALID_PARAMS, `Unknown tool: ${name}`, undefined, 400);
  }
  try {
    const result = await callTool(context, name, args);
    if (era === "modern") {
      return jsonRpcSuccess(id, decorateModernResult({ ...(result as Record<string, unknown>) }));
    }
    return jsonRpcSuccess(id, result);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonRpcFailure(id, INTERNAL_ERROR, error.message, undefined, authorizationHttpStatus(error.message));
    }
    if (error instanceof TypeError && error.message === "Tool arguments must be an object") {
      return jsonRpcFailure(id, INVALID_PARAMS, error.message, undefined, 400);
    }
    if (error instanceof Error && error.message.startsWith("Private key material")) {
      return jsonRpcFailure(id, INVALID_PARAMS, error.message, undefined, 400);
    }
    const text = error instanceof Error ? error.message : "Tool execution failed";
    if (era === "modern") {
      return jsonRpcSuccess(id, toolExecutionError(text));
    }
    return jsonRpcFailure(id, INTERNAL_ERROR, text);
  }
}

function handleLegacy(
  context: ChainPayMcpContext,
  message: ValidatedMessage,
  options: HandleOptions | undefined,
): Promise<JsonRpcResponse | null> | JsonRpcResponse | null {
  const id = responseId(message, "legacy") ?? null;
  if (!message.hasId) {
    if (message.method === "tools/call") {
      return jsonRpcFailure(undefined, INVALID_REQUEST, "tools/call is not a notification and was not executed", undefined, 400);
    }
    return null;
  }
  if (message.method.startsWith("notifications/")) {
    return jsonRpcFailure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`, undefined, 404);
  }

  switch (message.method) {
    case "initialize":
      return jsonRpcSuccess(id, {
        protocolVersion: negotiateLegacyProtocolVersion(message.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
        instructions: "ChainPay prepares and routes policy-controlled Solana payments. Wallet signatures and signer adapters remain outside MCP.",
      });
    case "ping":
      return jsonRpcSuccess(id, {});
    case "tools/list":
      return jsonRpcSuccess(id, { tools: listedToolDefinitions(TOOL_DEFINITIONS) });
    case "tools/call": {
      const name = message.params.name;
      if (typeof name !== "string" || name.length === 0) {
        return jsonRpcFailure(id, INVALID_PARAMS, "tools/call requires a tool name", undefined, 400);
      }
      try {
        const args = objectArguments(message.params.arguments);
        return callNamedTool(context, name, args, "legacy", id).then((response) => {
          if (isCancelled(options, message.id)) return null;
          return response;
        });
      } catch (error) {
        return jsonRpcFailure(id, INVALID_PARAMS, error instanceof Error ? error.message : "Invalid tool arguments", undefined, 400);
      }
    }
    default:
      if (!LEGACY_METHODS.has(message.method)) {
        return jsonRpcFailure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`, undefined, 404);
      }
      return jsonRpcFailure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`, undefined, 404);
  }
}

async function handleModern(
  context: ChainPayMcpContext,
  message: ValidatedMessage,
  classification: ProtocolClassification,
  options: HandleOptions | undefined,
): Promise<JsonRpcResponse | null> {
  const id = responseId(message, "modern");
  void classification.clientCapabilities;

  if (!message.hasId) {
    if (options?.transport === "http") {
      return jsonRpcFailure(undefined, INVALID_REQUEST, "Modern Streamable HTTP defines no client-sent notifications", undefined, 400);
    }
    if (message.method === "notifications/cancelled") {
      return null;
    }
    if (message.method === "tools/call") {
      return jsonRpcFailure(undefined, INVALID_REQUEST, "tools/call is not a notification and was not executed", undefined, 400);
    }
    return null;
  }

  if (message.method === "initialize" || message.method === "ping" || !MODERN_METHODS.has(message.method)) {
    return jsonRpcFailure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`, undefined, 404);
  }

  switch (message.method) {
    case "server/discover":
      return jsonRpcSuccess(id, modernDiscoverResult());
    case "tools/list":
      if (message.params.cursor !== undefined) {
        return jsonRpcFailure(id, INVALID_PARAMS, "Unknown cursor", undefined, 400);
      }
      return jsonRpcSuccess(id, modernToolsListResult(TOOL_DEFINITIONS));
    case "tools/call": {
      const name = message.params.name;
      if (typeof name !== "string" || name.length === 0) {
        return jsonRpcFailure(id, INVALID_PARAMS, "tools/call requires a tool name", undefined, 400);
      }
      try {
        const args = objectArguments(message.params.arguments);
        const response = await callNamedTool(context, name, args, "modern", id);
        if (isCancelled(options, message.id)) return null;
        return response;
      } catch (error) {
        return jsonRpcFailure(id, INVALID_PARAMS, error instanceof Error ? error.message : "Invalid tool arguments", undefined, 400);
      }
    }
    default:
      return jsonRpcFailure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`, undefined, 404);
  }
}

export function createMcpServer(context: ChainPayMcpContext) {
  return {
    async handle(input: unknown, options: HandleOptions = {}): Promise<JsonRpcResponse | null> {
      const parsed = parseJsonRpcMessage(input);
      if (!parsed.ok) return parsed.response;

      const classified = classifyProtocol(parsed.message, options.headerVersion);
      if (!classified.ok) return classified.response;

      if (classified.classification.era === "legacy") {
        return handleLegacy(context, parsed.message, options);
      }
      return handleModern(context, parsed.message, classified.classification, options);
    },
    async handleValidated(
      message: ValidatedMessage,
      classification: ProtocolClassification,
      options: HandleOptions = {},
    ): Promise<JsonRpcResponse | null> {
      if (classification.era === "legacy") {
        return handleLegacy(context, message, options);
      }
      return handleModern(context, message, classification, options);
    },
  };
}

function cancelledRequestId(params: Record<string, unknown>): RequestId | undefined {
  const requestId = params.requestId;
  if (typeof requestId === "string" || typeof requestId === "number") return requestId;
  return undefined;
}

export type StdioIo = {
  writeStdout: (line: string) => void;
  writeStderr?: (line: string) => void;
};

export function createStdioRuntime(context: ChainPayMcpContext, io: StdioIo) {
  const server = createMcpServer(context);
  const cancelled = new Set<string>();
  const inFlight = new Map<string, AbortController>();
  let active = 0;

  const idKey = (id: RequestId) => `${typeof id}:${id}`;

  const writeResponse = (response: JsonRpcResponse | null) => {
    if (!response) return;
    io.writeStdout(`${JSON.stringify(response)}\n`);
  };

  const dispatch = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      writeResponse(parseErrorResponse(error instanceof Error ? error.message : "Invalid JSON"));
      return;
    }

    const parsed = parseJsonRpcMessage(value);
    if (!parsed.ok) {
      writeResponse(parsed.response);
      return;
    }

    const classified = classifyProtocol(parsed.message);
    if (!classified.ok) {
      writeResponse(classified.response);
      return;
    }

    if (!parsed.message.hasId && parsed.message.method === "notifications/cancelled") {
      const requestId = cancelledRequestId(parsed.message.params);
      if (requestId !== undefined) {
        cancelled.add(idKey(requestId));
        inFlight.get(idKey(requestId))?.abort();
      }
      return;
    }

    const abort = new AbortController();
    const requestId = parsed.message.id;
    if (requestId !== undefined) inFlight.set(idKey(requestId), abort);
    active += 1;
    try {
      const response = await server.handleValidated(parsed.message, classified.classification, {
        transport: "stdio",
        signal: abort.signal,
        cancelled: (id) => cancelled.has(idKey(id)),
      });
      if (requestId !== undefined && cancelled.has(idKey(requestId))) return;
      writeResponse(response);
    } finally {
      if (requestId !== undefined) inFlight.delete(idKey(requestId));
      active -= 1;
    }
  };

  return {
    enqueue(line: string): Promise<void> {
      return dispatch(line);
    },
    get inFlightCount() {
      return active;
    },
  };
}

export async function runStdioServer(context: ChainPayMcpContext = createDefaultContext()): Promise<void> {
  const runtime = createStdioRuntime(context, {
    writeStdout: (line) => {
      process.stdout.write(line);
    },
    writeStderr: (line) => {
      process.stderr.write(line);
    },
  });

  let buffer = Buffer.alloc(0);
  const pending = new Set<Promise<void>>();

  const enqueueLine = (line: string) => {
    const task = runtime.enqueue(line).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }).finally(() => {
      pending.delete(task);
    });
    pending.add(task);
  };

  for await (const chunk of process.stdin) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length + piece.length > MAX_MCP_BYTES) {
      enqueueLine("");
      process.stderr.write("MCP stdio line exceeded the input byte limit\n");
      writeOversizedError();
      buffer = Buffer.alloc(0);
      continue;
    }
    buffer = Buffer.concat([buffer, piece]);
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      while (pending.size >= MAX_STDIO_IN_FLIGHT) {
        await Promise.race(pending);
      }
      const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(newline + 1);
      enqueueLine(line);
      newline = buffer.indexOf(0x0a);
    }
  }

  await Promise.all(pending);
}

function writeOversizedError(): void {
  process.stdout.write(`${JSON.stringify(jsonRpcFailure(undefined, INVALID_REQUEST, "MCP request line is too large", undefined, 400))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
