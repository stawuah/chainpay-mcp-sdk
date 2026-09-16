import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg, { type Pool, type PoolClient } from "pg";

const { Pool: PostgresPool } = pg;

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

type MemoryConnectionRecord = PublicMcpConnection & { tokenHash: string; revokedAt: string | null };

export type RegisterConnectionInput = {
  wallet: string;
  agentName: string;
  scope?: string;
};

export type InboxRole = "user" | "assistant" | "tool";

export type PublicInboxMessage = {
  id: string;
  wallet: string;
  role: InboxRole;
  content: unknown;
  createdAt: string;
};

type MemoryInboxMessage = PublicInboxMessage & { sequence: number };

type ConnectionRow = {
  connection_id: string;
  wallet_address: string;
  agent_name: string;
  scope: string;
  connected_at: Date | string;
  last_seen_at: Date | string | null;
  total_calls: string | number;
  tools_called: unknown;
};

type InboxRow = {
  message_id: string;
  wallet_address: string;
  role: InboxRole;
  content: unknown;
  created_at: Date | string;
};

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const [scheme, token] = authorization.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isoTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toolCalls(value: unknown): ConnectionToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Partial<ConnectionToolCall>;
    if (typeof candidate.name !== "string" || typeof candidate.count !== "number" || typeof candidate.lastCalledAt !== "string") return [];
    return [{ name: candidate.name, count: candidate.count, lastCalledAt: candidate.lastCalledAt }];
  });
}

function publicConnection(row: ConnectionRow): PublicMcpConnection {
  return {
    id: row.connection_id,
    wallet: row.wallet_address,
    agentName: row.agent_name,
    scope: row.scope,
    connectedAt: isoTime(row.connected_at),
    lastSeenAt: row.last_seen_at ? isoTime(row.last_seen_at) : null,
    totalCalls: Number(row.total_calls),
    toolsCalled: toolCalls(row.tools_called),
  };
}

function publicInboxMessage(row: InboxRow): PublicInboxMessage {
  return {
    id: row.message_id,
    wallet: row.wallet_address,
    role: row.role,
    content: row.content,
    createdAt: isoTime(row.created_at),
  };
}

export class McpConnectionRegistry {
  private readonly records = new Map<string, MemoryConnectionRecord>();
  private readonly inbox = new Map<string, MemoryInboxMessage>();
  private inboxSequence = 0;

  constructor(private readonly pool?: Pool) {}

  /** Test-only in-memory storage. HTTP production startup uses fromEnv(). */
  static inMemory(): McpConnectionRegistry {
    return new McpConnectionRegistry();
  }

  static async fromEnv(): Promise<McpConnectionRegistry> {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required; MCP persistence cannot fall back to memory");
    }
    const pool = new PostgresPool({ connectionString: databaseUrl, max: 10 });
    try {
      await pool.query("SELECT connection_id FROM agent_connections LIMIT 0");
      await pool.query("SELECT message_id FROM inbox_messages LIMIT 0");
    } catch (error) {
      await pool.end();
      throw error;
    }
    return new McpConnectionRegistry(pool);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async register(input: RegisterConnectionInput) {
    const wallet = input.wallet.trim();
    const agentName = input.agentName.trim();
    if (!wallet || wallet.length > 44) throw new Error("wallet is required and must be a Solana address");
    if (!agentName || agentName.length > 128) throw new Error("agentName must contain 1..128 characters");
    if ((input.scope?.length ?? 0) > 8192) throw new Error("scope is too large");

    const now = new Date().toISOString();
    const token = `cp_agent_${randomBytes(24).toString("hex")}`;
    const record: MemoryConnectionRecord = {
      id: `conn_${randomUUID()}`,
      tokenHash: tokenHash(token),
      wallet,
      agentName,
      scope: input.scope?.trim() || "Unscoped",
      connectedAt: now,
      lastSeenAt: null,
      totalCalls: 0,
      toolsCalled: [],
      revokedAt: null,
    };

    if (this.pool) {
      const result = await this.pool.query<ConnectionRow>(
        `INSERT INTO agent_connections (
           connection_id, wallet_address, agent_name, scope, token_hash,
           created_at, last_seen_at, total_calls, tools_called
         ) VALUES ($1, $2, $3, $4, $5, $6, NULL, 0, '[]'::JSONB)
         RETURNING connection_id, wallet_address, agent_name, scope, created_at AS connected_at,
                   NULL::TIMESTAMPTZ AS last_seen_at, total_calls, tools_called`,
        [record.id, record.wallet, record.agentName, record.scope, record.tokenHash, record.connectedAt],
      );
      return { connection: publicConnection(result.rows[0]), token };
    }

    this.records.set(record.id, record);
    return { connection: this.publicMemoryRecord(record), token };
  }

  async identify(request: IncomingMessage): Promise<PublicMcpConnection | undefined> {
    const token = bearerToken(request);
    if (!token) return undefined;
    const hash = tokenHash(token);
    if (this.pool) {
      const result = await this.pool.query<ConnectionRow>(
        `${CONNECTION_SELECT}
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hash],
      );
      return result.rows[0] ? publicConnection(result.rows[0]) : undefined;
    }
    const record = [...this.records.values()].find((value) => value.tokenHash === hash && !value.revokedAt);
    return record ? this.publicMemoryRecord(record) : undefined;
  }

  async observe(request: IncomingMessage, name?: string): Promise<void> {
    const token = bearerToken(request);
    if (!token) return;
    const hash = tokenHash(token);
    const now = new Date().toISOString();

    if (this.pool) {
      if (!name) {
        await this.pool.query(
          "UPDATE agent_connections SET last_seen_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
          [hash, now],
        );
        return;
      }
      const client = await this.pool.connect();
      try {
        await this.observePostgres(client, hash, name, now);
      } finally {
        client.release();
      }
      return;
    }

    const record = [...this.records.values()].find((value) => value.tokenHash === hash && !value.revokedAt);
    if (!record) return;
    this.applyObservation(record, name, now);
  }

  async list(wallet: string): Promise<PublicMcpConnection[]> {
    const normalized = wallet.trim();
    if (this.pool) {
      const result = await this.pool.query<ConnectionRow>(
        `${CONNECTION_SELECT}
         WHERE wallet_address = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC`,
        [normalized],
      );
      return result.rows.map(publicConnection);
    }
    return [...this.records.values()]
      .filter((record) => record.wallet === normalized && !record.revokedAt)
      .sort((left, right) => right.connectedAt.localeCompare(left.connectedAt))
      .map((record) => this.publicMemoryRecord(record));
  }

  async revoke(wallet: string, id: string): Promise<boolean> {
    const normalized = wallet.trim();
    const now = new Date().toISOString();
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE agent_connections
         SET revoked_at = $3
         WHERE connection_id = $1 AND wallet_address = $2 AND revoked_at IS NULL`,
        [id, normalized, now],
      );
      return result.rowCount === 1;
    }
    const record = this.records.get(id);
    if (!record || record.wallet !== normalized || record.revokedAt) return false;
    record.revokedAt = now;
    return true;
  }

  async appendInboxMessage(wallet: string, role: InboxRole, content: unknown): Promise<PublicInboxMessage> {
    const normalized = wallet.trim();
    if (!normalized) throw new Error("wallet is required to persist inbox history");
    const record: MemoryInboxMessage = {
      id: `msg_${randomUUID()}`,
      wallet: normalized,
      role,
      content,
      createdAt: new Date().toISOString(),
      sequence: ++this.inboxSequence,
    };
    if (this.pool) {
      const result = await this.pool.query<InboxRow>(
        `INSERT INTO inbox_messages (message_id, wallet_address, role, content, created_at)
         VALUES ($1, $2, $3, $4::JSONB, $5)
         RETURNING message_id, wallet_address, role, content, created_at`,
        [record.id, record.wallet, record.role, JSON.stringify(record.content), record.createdAt],
      );
      return publicInboxMessage(result.rows[0]);
    }
    this.inbox.set(record.id, record);
    return this.publicMemoryInbox(record);
  }

  async listInbox(wallet: string, limit = 30): Promise<PublicInboxMessage[]> {
    const normalized = wallet.trim();
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    if (this.pool) {
      const result = await this.pool.query<InboxRow>(
        `SELECT message_id, wallet_address, role, content, created_at
         FROM inbox_messages
         WHERE wallet_address = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [normalized, boundedLimit],
      );
      return result.rows.map(publicInboxMessage);
    }
    return [...this.inbox.values()]
      .filter((message) => message.wallet === normalized)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, boundedLimit)
      .map((message) => this.publicMemoryInbox(message));
  }

  private async observePostgres(client: PoolClient, hash: string, name: string, now: string): Promise<void> {
    await client.query("BEGIN");
    try {
      const selected = await client.query<ConnectionRow>(
        `${CONNECTION_SELECT}
         WHERE token_hash = $1 AND revoked_at IS NULL
         FOR UPDATE`,
        [hash],
      );
      const row = selected.rows[0];
      if (row) {
        const calls = toolCalls(row.tools_called);
        this.updateToolCalls(calls, name, now);
        await client.query(
          `UPDATE agent_connections
           SET last_seen_at = $2, total_calls = total_calls + 1, tools_called = $3::JSONB
           WHERE connection_id = $1`,
          [row.connection_id, now, JSON.stringify(calls)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  private applyObservation(record: MemoryConnectionRecord, name: string | undefined, now: string): void {
    record.lastSeenAt = now;
    if (!name) return;
    record.totalCalls += 1;
    this.updateToolCalls(record.toolsCalled, name, now);
  }

  private updateToolCalls(calls: ConnectionToolCall[], name: string, now: string): void {
    const existing = calls.find((tool) => tool.name === name);
    if (existing) {
      existing.count += 1;
      existing.lastCalledAt = now;
    } else {
      calls.push({ name, count: 1, lastCalledAt: now });
    }
  }

  private publicMemoryRecord(record: MemoryConnectionRecord): PublicMcpConnection {
    const { tokenHash: _tokenHash, revokedAt: _revokedAt, ...publicRecord } = record;
    return publicRecord;
  }

  private publicMemoryInbox(record: MemoryInboxMessage): PublicInboxMessage {
    const { sequence: _sequence, ...publicRecord } = record;
    return publicRecord;
  }
}

const CONNECTION_SELECT = `
  SELECT connection_id, wallet_address, agent_name, scope,
         created_at AS connected_at, last_seen_at, total_calls, tools_called
  FROM agent_connections`;
