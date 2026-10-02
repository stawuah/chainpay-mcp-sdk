import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultContext } from "./index.js";
import { McpConnectionRegistry } from "./connections.js";
import { createHttpHandler } from "./http.js";

let ready: Promise<ReturnType<typeof createHttpHandler>> | undefined;

/** Cached configuration only; identity is resolved separately for every request. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    ready ??= McpConnectionRegistry.fromEnv()
      .then(registry => createHttpHandler(createDefaultContext(), {}, registry))
      .catch(error => { ready = undefined; throw error; });
    const app = await ready;
    await app.handler(req, res);
  } catch {
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Service temporarily unavailable; reconcile pending operations before retrying." }));
    } else res.end();
  }
}
