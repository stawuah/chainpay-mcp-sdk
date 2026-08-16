import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createDefaultContext, TOOL_DEFINITIONS } from "./index.js";
import { renderDocsHtml } from "./docs.js";
import { CHAINPAY_LOGO_SVG } from "./logo.js";
import { createChainPayOgImage } from "./og-image.js";
import { runChainPayAgent, type ChainPayAgentRequest } from "./agent.js";
import {
  createMcpServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./server.js";
import { McpConnectionRegistry, type RegisterConnectionInput } from "./connections.js";
import type { ChainPayMcpContext } from "./tools/context.js";

const MAX_BODY_BYTES = 4_194_304;
const CHAINPAY_OG_IMAGE = createChainPayOgImage();
const AGENT_RATE_WINDOW_MS = 60_000;
const AGENT_RATE_LIMIT = 20;
const agentRateRecords = new Map<string, { startedAt: number; count: number }>();

type HttpOptions = {
  host?: string;
  port?: number;
  path?: string;
  authToken?: string;
  allowedOrigins?: string[];
};

function envOptions(): Required<HttpOptions> {
  const allowedOrigins = (process.env.CHAINPAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    host: process.env.CHAINPAY_HTTP_HOST ?? "0.0.0.0",
    port: Number.parseInt(process.env.CHAINPAY_HTTP_PORT ?? process.env.PORT ?? "3000", 10),
    path: process.env.CHAINPAY_HTTP_PATH ?? "/mcp",
    authToken: process.env.CHAINPAY_HTTP_AUTH_TOKEN ?? "",
    allowedOrigins,
  };
}

function writeJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  res.end(body);
}

function writeSvg(res: ServerResponse, svg: string, headers: Record<string, string> = {}) {
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
    "Content-Length": Buffer.byteLength(svg).toString(),
    ...headers,
  });
  res.end(svg);
}

function writePng(res: ServerResponse, image: Buffer, headers: Record<string, string> = {}) {
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
    "Content-Length": image.length.toString(),
    ...headers,
  });
  res.end(image);
}

function writeHtml(res: ServerResponse, html: string, headers: Record<string, string> = {}) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "Content-Length": Buffer.byteLength(html).toString(),
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(html);
}

function corsHeaders(origin: string | undefined, allowedOrigins: string[]): Record<string, string> | null {
  if (!origin) return {};
  if (!allowedOrigins.includes("*") && !allowedOrigins.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function authAllowed(req: IncomingMessage, authToken: string): boolean {
  if (!authToken) return true;
  return req.headers.authorization === `Bearer ${authToken}`;
}

function agentRequestAllowed(req: IncomingMessage): boolean {
  const forwarded = req.headers["x-forwarded-for"];
  const address = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const current = agentRateRecords.get(address);
  if (!current || now - current.startedAt >= AGENT_RATE_WINDOW_MS) {
    agentRateRecords.set(address, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= AGENT_RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

function requestHeadersValid(req: IncomingMessage, request: JsonRpcRequest): string | undefined {
  const methodHeader = req.headers["mcp-method"];
  if (typeof methodHeader === "string" && methodHeader !== request.method) {
    return "Mcp-Method does not match the JSON-RPC method";
  }

  const nameHeader = req.headers["mcp-name"];
  if (request.method === "tools/call" && typeof nameHeader === "string") {
    const name = request.params?.name;
    if (typeof name !== "string" || nameHeader !== name) {
      return "Mcp-Name does not match the requested tool";
    }
  }
  return undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<JsonRpcRequest> {
  const parsed = await readJsonValue(req);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    typeof (parsed as { method?: unknown }).method !== "string"
  ) {
    throw new Error("MCP HTTP requests must contain one JSON-RPC object");
  }
  return parsed as JsonRpcRequest;
}

async function readJsonValue(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("MCP request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function jsonRpcError(id: string | number | null, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32600, message },
  };
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  context: ChainPayMcpContext,
  mcpServer: ReturnType<typeof createMcpServer>,
  registry: McpConnectionRegistry,
  options: Required<HttpOptions>,
  headers: Record<string, string>,
): Promise<void> {
  if (!authAllowed(req, options.authToken) && !registry.identify(req)) {
    writeJson(res, 401, { error: "Unauthorized" }, { ...headers, "WWW-Authenticate": "Bearer" });
    return;
  }

  let request: JsonRpcRequest;
  try {
    request = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, jsonRpcError(null, error instanceof Error ? error.message : String(error)), headers);
    return;
  }

  const headerError = requestHeadersValid(req, request);
  if (headerError) {
    writeJson(res, 400, jsonRpcError(request.id ?? null, headerError), headers);
    return;
  }

  registry.observe(req, request.method === "tools/call" && typeof request.params?.name === "string" ? request.params.name : undefined);
  const response = await mcpServer.handle(request);
  if (!response) {
    res.writeHead(202, headers);
    res.end();
    return;
  }

  writeJson(res, 200, response, headers);
}

function openEventStream(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): void {
  res.writeHead(200, {
    ...headers,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": chainpay-mcp stream\n\n");
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => clearInterval(heartbeat));
}

export function createHttpServer(
  context: ChainPayMcpContext,
  options: HttpOptions = {},
) {
  const environment = envOptions();
  const resolved: Required<HttpOptions> = {
    ...environment,
    ...options,
    port: options.port ?? environment.port,
    allowedOrigins: options.allowedOrigins ?? environment.allowedOrigins,
  };

  if (!Number.isInteger(resolved.port) || resolved.port < 1 || resolved.port > 65_535) {
    throw new Error("CHAINPAY_HTTP_PORT must be a valid TCP port");
  }

  const mcpServer = createMcpServer(context);
  const registry = new McpConnectionRegistry();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const cors = corsHeaders(req.headers.origin, resolved.allowedOrigins);
    if (cors === null) {
      writeJson(res, 403, { error: "Origin is not allowed" });
      return;
    }
    const headers = {
      ...cors,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Method, Mcp-Name, Mcp-Protocol-Version, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (url.pathname === "/logo.svg" && req.method === "GET") {
      writeSvg(res, CHAINPAY_LOGO_SVG, headers);
      return;
    }

    if (url.pathname === "/og-image.png" && req.method === "GET") {
      writePng(res, CHAINPAY_OG_IMAGE, headers);
      return;
    }

    if ((url.pathname === "/" || url.pathname === "/docs") && req.method === "GET") {
      writeHtml(res, renderDocsHtml(), headers);
      return;
    }

    if (url.pathname === "/healthz" && req.method === "GET") {
      writeJson(res, 200, { status: "ok", transport: "streamable-http", endpoint: resolved.path }, headers);
      return;
    }

    if (url.pathname === "/tools" && req.method === "GET") {
      writeJson(res, 200, {
        service: "chainpay-mcp",
        transport: "streamable-http",
        endpoint: resolved.path,
        tools: TOOL_DEFINITIONS,
      }, headers);
      return;
    }

    if (url.pathname === "/connections" && req.method === "GET") {
      const wallet = url.searchParams.get("wallet")?.trim();
      if (!wallet) {
        writeJson(res, 400, { error: "wallet query parameter is required" }, headers);
        return;
      }
      writeJson(res, 200, { connections: registry.list(wallet) }, headers);
      return;
    }

    if (url.pathname === "/connections" && req.method === "POST") {
      try {
        const body = await readJsonValue(req) as Partial<RegisterConnectionInput>;
        const registered = registry.register({
          wallet: typeof body.wallet === "string" ? body.wallet : "",
          agentName: typeof body.agentName === "string" ? body.agentName : "",
          scope: typeof body.scope === "string" ? body.scope : undefined,
        });
        writeJson(res, 201, registered, headers);
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }, headers);
      }
      return;
    }

    if (url.pathname === "/agent/chat" && req.method === "POST") {
      if (!agentRequestAllowed(req)) {
        writeJson(res, 429, { error: "Too many assistant requests. Try again in a minute." }, headers);
        return;
      }
      try {
        const body = await readJsonValue(req) as Partial<ChainPayAgentRequest>;
        const result = await runChainPayAgent(context, {
          message: body.message ?? "",
          wallet: body.wallet,
          mandateAddress: body.mandateAddress,
          paymentRequest: body.paymentRequest,
          attachments: body.attachments,
          history: body.history,
        });
        writeJson(res, 200, result, headers);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("not configured") ? 503 : 400;
        writeJson(res, status, { error: message }, headers);
      }
      return;
    }

    const revokeMatch = url.pathname.match(/^\/connections\/([^/]+)$/);
    if (revokeMatch && req.method === "DELETE") {
      const wallet = url.searchParams.get("wallet")?.trim();
      const revoked = wallet ? registry.revoke(wallet, decodeURIComponent(revokeMatch[1])) : false;
      writeJson(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: "Connection not found" }, headers);
      return;
    }

    if (url.pathname !== resolved.path) {
      writeJson(res, 404, { error: "Not found" }, headers);
      return;
    }

    if (req.method === "GET") {
      if (!authAllowed(req, resolved.authToken) && !registry.identify(req)) {
        writeJson(res, 401, { error: "Unauthorized" }, { ...headers, "WWW-Authenticate": "Bearer" });
        return;
      }
      registry.observe(req);
      openEventStream(req, res, headers);
      return;
    }

    if (req.method === "POST") {
      await handleMcpPost(req, res, context, mcpServer, registry, resolved, headers);
      return;
    }

    writeJson(res, 405, { error: "Method not allowed" }, { ...headers, Allow: "GET, POST, OPTIONS" });
  });

  return { server, options: resolved, mcpServer, registry, tools: TOOL_DEFINITIONS };
}

export async function runHttpServer(context: ChainPayMcpContext = createDefaultContext()): Promise<void> {
  const { server, options } = createHttpServer(context);
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => {
      process.stderr.write(`ChainPay MCP HTTP listening on http://${options.host}:${options.port}${options.path}\n`);
      if (!options.authToken) {
        process.stderr.write("Warning: CHAINPAY_HTTP_AUTH_TOKEN is not set; configure authentication before public deployment.\n");
      }
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHttpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
