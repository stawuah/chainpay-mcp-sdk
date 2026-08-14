import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type ConnectionToolCall = {
  name: string;
  count: number;
  lastCalledAt: string;
};

export type PublicMcpConnection = {
  id: string;
  wallet: string;
  agentName: string;
  scope: string;
  connectedAt: string;
  lastSeenAt: string | null;
  totalCalls: number;
  toolsCalled: ConnectionToolCall[];
};

type ConnectionRecord = PublicMcpConnection & { token: string };

export type RegisterConnectionInput = {
  wallet: string;
  agentName: string;
  scope?: string;
};

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const [scheme, token] = authorization.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

export class McpConnectionRegistry {
  private readonly records = new Map<string, ConnectionRecord>();

  register(input: RegisterConnectionInput) {
    const wallet = input.wallet.trim();
    const agentName = input.agentName.trim();
    if (!wallet) throw new Error("wallet is required");
    if (!agentName) throw new Error("agentName is required");

    const now = new Date().toISOString();
    const record: ConnectionRecord = {
      id: `conn_${randomUUID()}`,
      token: `cp_agent_${randomBytes(24).toString("hex")}`,
      wallet,
      agentName,
      scope: input.scope?.trim() || "Unscoped",
      connectedAt: now,
      lastSeenAt: null,
      totalCalls: 0,
      toolsCalled: [],
    };
    this.records.set(record.id, record);
    return { connection: this.publicRecord(record), token: record.token };
  }

  identify(request: IncomingMessage) {
    const token = bearerToken(request);
    if (!token) return undefined;
    return [...this.records.values()].find((record) => record.token === token);
  }

  observe(request: IncomingMessage, toolName?: string) {
    const record = this.identify(request);
    if (!record) return;
    const now = new Date().toISOString();
    record.lastSeenAt = now;
    if (!toolName) return;
    record.totalCalls += 1;
    const existing = record.toolsCalled.find((tool) => tool.name === toolName);
    if (existing) {
      existing.count += 1;
      existing.lastCalledAt = now;
    } else {
      record.toolsCalled.push({ name: toolName, count: 1, lastCalledAt: now });
    }
  }

  list(wallet: string) {
    return [...this.records.values()]
      .filter((record) => record.wallet === wallet.trim())
      .sort((left, right) => right.connectedAt.localeCompare(left.connectedAt))
      .map((record) => this.publicRecord(record));
  }

  revoke(wallet: string, id: string) {
    const record = this.records.get(id);
    if (!record || record.wallet !== wallet.trim()) return false;
    this.records.delete(id);
    return true;
  }

  private publicRecord(record: ConnectionRecord): PublicMcpConnection {
    const { token: _token, ...publicRecord } = record;
    return publicRecord;
  }
}
