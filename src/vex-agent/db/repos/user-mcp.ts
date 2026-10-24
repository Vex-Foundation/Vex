/**
 * The user's own MCP servers and their tools (F12, migration 183).
 *
 * Written only by the Electron main process (Settings IPC and the recheck
 * worker) and read by the engine's tool lane. Trust is widened only here, and
 * only by Settings: chat can call an enabled tool, never add a server, turn a
 * tool on or let it run without asking.
 *
 * Two rules are held twice, in code and in a database CHECK: a tool runs
 * without asking only when its server declared it read-only, and only an
 * `active` tool can be on.
 */

import type pg from "pg";
import { executeWith, getPool, query, queryOne, queryOneWith, queryWith, withTransaction } from "../client.js";
import { jsonb } from "../params.js";
import {
  FAILURES_BEFORE_ERROR,
  MAX_ENABLED_TOOLS,
  RECHECK_AFTER_MS,
  RECHECK_BATCH,
} from "@vex-agent/user-mcp/limits.js";

export type UserMcpNetworkScope = "public" | "local";
export type UserMcpServerStatus = "active" | "error" | "disabled";
export type UserMcpToolStatus = "active" | "drifted" | "unsupported";

export interface UserMcpServer {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly networkScope: UserMcpNetworkScope;
  readonly hasToken: boolean;
  readonly status: UserMcpServerStatus;
  readonly failures: number;
  readonly lastCheckedAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

export interface UserMcpTool {
  readonly id: string;
  readonly serverId: string;
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly schemaHash: string;
  readonly readOnlyHint: boolean;
  readonly enabled: boolean;
  readonly autoRun: boolean;
  readonly status: UserMcpToolStatus;
  readonly unsupportedReason: string | null;
  readonly enabledAt: Date | null;
}

/** A tool as a listing returned it, ready to store. */
export interface ListedToolRecord {
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly schemaHash: string;
  readonly readOnlyHint: boolean;
  /** Set when the schema converter refused the schema. */
  readonly unsupportedReason: string | null;
}

/** Everything the lane needs to call one tool, read in one join. */
export interface CallableUserMcpTool {
  readonly toolId: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly endpoint: string;
  readonly networkScope: UserMcpNetworkScope;
  readonly hasToken: boolean;
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly readOnlyHint: boolean;
  readonly autoRun: boolean;
  readonly enabledAt: Date | null;
}

interface ServerRow {
  id: string;
  name: string;
  endpoint: string;
  network_scope: UserMcpNetworkScope;
  has_token: boolean;
  status: UserMcpServerStatus;
  failures: number;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

interface ToolRow {
  id: string;
  server_id: string;
  remote_name: string;
  description: string;
  input_schema: unknown;
  schema_hash: string;
  read_only_hint: boolean;
  enabled: boolean;
  auto_run: boolean;
  status: UserMcpToolStatus;
  unsupported_reason: string | null;
  enabled_at: Date | null;
}

interface CallableRow {
  tool_id: string;
  server_id: string;
  server_name: string;
  endpoint: string;
  network_scope: UserMcpNetworkScope;
  has_token: boolean;
  remote_name: string;
  description: string;
  input_schema: unknown;
  read_only_hint: boolean;
  auto_run: boolean;
  enabled_at: Date | null;
}

const SERVER_COLUMNS =
  "id, name, endpoint, network_scope, has_token, status, failures, last_checked_at, last_error, created_at";
const TOOL_COLUMNS =
  "id, server_id, remote_name, description, input_schema, schema_hash, read_only_hint, enabled, auto_run, status, unsupported_reason, enabled_at";
const CALLABLE_SELECT = `
  SELECT t.id AS tool_id, s.id AS server_id, s.name AS server_name, s.endpoint, s.network_scope,
         s.has_token, t.remote_name, t.description, t.input_schema, t.read_only_hint, t.auto_run,
         t.enabled_at
    FROM user_mcp_tools t
    JOIN user_mcp_servers s ON s.id = t.server_id
   WHERE t.enabled AND t.status = 'active' AND s.status = 'active'`;

function toServer(row: ServerRow): UserMcpServer {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    networkScope: row.network_scope,
    hasToken: row.has_token,
    status: row.status,
    failures: row.failures,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function toTool(row: ToolRow): UserMcpTool {
  return {
    id: row.id,
    serverId: row.server_id,
    remoteName: row.remote_name,
    description: row.description,
    inputSchema: row.input_schema,
    schemaHash: row.schema_hash,
    readOnlyHint: row.read_only_hint,
    enabled: row.enabled,
    autoRun: row.auto_run,
    status: row.status,
    unsupportedReason: row.unsupported_reason,
    enabledAt: row.enabled_at,
  };
}

function toCallable(row: CallableRow): CallableUserMcpTool {
  return {
    toolId: row.tool_id,
    serverId: row.server_id,
    serverName: row.server_name,
    endpoint: row.endpoint,
    networkScope: row.network_scope,
    hasToken: row.has_token,
    remoteName: row.remote_name,
    description: row.description,
    inputSchema: row.input_schema,
    readOnlyHint: row.read_only_hint,
    autoRun: row.auto_run,
    enabledAt: row.enabled_at,
  };
}

// ── Reads ────────────────────────────────────────────────────────

export async function listServersWithTools(): Promise<
  ReadonlyArray<{ readonly server: UserMcpServer; readonly tools: readonly UserMcpTool[] }>
> {
  const servers = await query<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM user_mcp_servers ORDER BY created_at, id`);
  if (servers.length === 0) return [];
  const tools = await query<ToolRow>(`SELECT ${TOOL_COLUMNS} FROM user_mcp_tools ORDER BY remote_name`);
  return servers.map((row) => ({
    server: toServer(row),
    tools: tools.filter((t) => t.server_id === row.id).map(toTool),
  }));
}

export async function getServer(serverId: string): Promise<UserMcpServer | null> {
  const row = await queryOne<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM user_mcp_servers WHERE id = $1`, [serverId]);
  return row === null ? null : toServer(row);
}

export async function countServers(): Promise<number> {
  const row = await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM user_mcp_servers");
  return Number(row?.n ?? 0);
}

export async function serverWithEndpointExists(endpoint: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>("SELECT id FROM user_mcp_servers WHERE endpoint = $1", [endpoint]);
  return row !== null;
}

/**
 * The tools the lane may offer, oldest turned-on first: on, `active`, on an
 * `active` server. At most `limit` (the enabled cap).
 */
export async function listCallableTools(limit = MAX_ENABLED_TOOLS): Promise<readonly CallableUserMcpTool[]> {
  const rows = await query<CallableRow>(`${CALLABLE_SELECT} ORDER BY t.enabled_at, t.id LIMIT $1`, [limit]);
  return rows.map(toCallable);
}

/**
 * The one tool a model-visible name points at, re-read at call time. `null`
 * when it is off, drifted, unsupported, removed, or its server is not active,
 * so an approval resumed after any of those refuses.
 */
export async function getCallableToolByNamePrefix(hexPrefix: string): Promise<CallableUserMcpTool | null> {
  if (!/^[0-9a-f]{16}$/.test(hexPrefix)) return null;
  const rows = await query<CallableRow>(
    `${CALLABLE_SELECT} AND left(replace(t.id::text, '-', ''), 16) = $1 LIMIT 2`,
    [hexPrefix],
  );
  // Two tools sharing 64 random bits would make the name ambiguous: refuse.
  return rows.length === 1 ? toCallable(rows[0]!) : null;
}

// ── Writes (Settings) ────────────────────────────────────────────

export interface InsertServerInput {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly networkScope: UserMcpNetworkScope;
  readonly hasToken: boolean;
  readonly tools: readonly ListedToolRecord[];
}

/** The server and every tool it listed, in one transaction, every tool off. */
export async function insertServerWithTools(input: InsertServerInput): Promise<void> {
  await withTransaction(async (client) => {
    await executeWith(
      client,
      `INSERT INTO user_mcp_servers (id, name, endpoint, network_scope, has_token, last_checked_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [input.id, input.name, input.endpoint, input.networkScope, input.hasToken],
    );
    for (const tool of input.tools) {
      await insertTool(client, input.id, tool);
    }
  });
}

async function insertTool(client: pg.PoolClient, serverId: string, tool: ListedToolRecord): Promise<void> {
  await executeWith(
    client,
    `INSERT INTO user_mcp_tools
       (server_id, remote_name, description, input_schema, schema_hash, read_only_hint, status, unsupported_reason)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      serverId,
      tool.remoteName,
      tool.description,
      jsonb(tool.inputSchema),
      tool.schemaHash,
      tool.readOnlyHint,
      tool.unsupportedReason === null ? "active" : "unsupported",
      tool.unsupportedReason,
    ],
  );
}

/** Remove a server and (by cascade) its tools. `false` when there was none. */
export async function removeServer(serverId: string): Promise<boolean> {
  const removed = await executeWith(getPool(), "DELETE FROM user_mcp_servers WHERE id = $1", [serverId]);
  return removed > 0;
}

export async function setServerHasToken(serverId: string, hasToken: boolean): Promise<boolean> {
  const changed = await executeWith(
    getPool(),
    "UPDATE user_mcp_servers SET has_token = $2, updated_at = now() WHERE id = $1",
    [serverId, hasToken],
  );
  return changed > 0;
}

export type SetToolEnabledOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "not_active" | "server_not_active" | "cap_reached" };

/**
 * Turn a tool on or off. Turning on refuses a tool that is not `active` or
 * whose server is not, and counts the enabled tools against the cap under a
 * lock, so two quick clicks cannot pass the cap. Turning off also clears
 * "Run without asking".
 */
export async function setToolEnabled(toolId: string, enabled: boolean): Promise<SetToolEnabledOutcome> {
  return withTransaction(async (client) => {
    // One writer at a time for the enabled set: the cap is counted across rows.
    await client.query("LOCK TABLE user_mcp_tools IN SHARE ROW EXCLUSIVE MODE");
    const row = await queryOneWith<{ status: UserMcpToolStatus; enabled: boolean; server_status: UserMcpServerStatus }>(
      client,
      `SELECT t.status, t.enabled, s.status AS server_status
         FROM user_mcp_tools t JOIN user_mcp_servers s ON s.id = t.server_id
        WHERE t.id = $1`,
      [toolId],
    );
    if (row === null) return { ok: false, reason: "not_found" } as const;
    if (!enabled) {
      await executeWith(
        client,
        "UPDATE user_mcp_tools SET enabled = false, auto_run = false, enabled_at = NULL, updated_at = now() WHERE id = $1",
        [toolId],
      );
      return { ok: true } as const;
    }
    if (row.enabled) return { ok: true } as const;
    if (row.status !== "active") return { ok: false, reason: "not_active" } as const;
    if (row.server_status !== "active") return { ok: false, reason: "server_not_active" } as const;
    const count = await queryOneWith<{ n: string }>(
      client,
      "SELECT count(*)::text AS n FROM user_mcp_tools WHERE enabled",
    );
    if (Number(count?.n ?? 0) >= MAX_ENABLED_TOOLS) return { ok: false, reason: "cap_reached" } as const;
    await executeWith(
      client,
      "UPDATE user_mcp_tools SET enabled = true, enabled_at = now(), updated_at = now() WHERE id = $1",
      [toolId],
    );
    return { ok: true } as const;
  });
}

export type SetToolAutoRunOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "not_read_only" | "not_enabled" };

/**
 * "Run without asking". Turning it on needs a tool that is on and that its
 * server declared read-only; the `WHERE` holds that, and so does the table's
 * CHECK.
 */
export async function setToolAutoRun(toolId: string, autoRun: boolean): Promise<SetToolAutoRunOutcome> {
  if (!autoRun) {
    const changed = await executeWith(
      getPool(),
      "UPDATE user_mcp_tools SET auto_run = false, updated_at = now() WHERE id = $1",
      [toolId],
    );
    return changed > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  }
  const changed = await executeWith(
    getPool(),
    `UPDATE user_mcp_tools SET auto_run = true, updated_at = now()
      WHERE id = $1 AND read_only_hint AND enabled AND status = 'active'`,
    [toolId],
  );
  if (changed > 0) return { ok: true };
  const row = await queryOne<{ read_only_hint: boolean; enabled: boolean }>(
    "SELECT read_only_hint, enabled FROM user_mcp_tools WHERE id = $1",
    [toolId],
  );
  if (row === null) return { ok: false, reason: "not_found" };
  return { ok: false, reason: row.read_only_hint ? "not_enabled" : "not_read_only" };
}

// ── Recheck (worker and "Check now") ─────────────────────────────

/** Active or failing servers whose listing is older than the recheck window. */
export async function dueServers(limit = RECHECK_BATCH, olderThanMs = RECHECK_AFTER_MS): Promise<readonly UserMcpServer[]> {
  const rows = await query<ServerRow>(
    `SELECT ${SERVER_COLUMNS} FROM user_mcp_servers
      WHERE status IN ('active', 'error')
        AND (last_checked_at IS NULL OR last_checked_at < now() - ($2::double precision * interval '1 millisecond'))
      ORDER BY last_checked_at NULLS FIRST, id
      LIMIT $1`,
    [limit, olderThanMs],
  );
  return rows.map(toServer);
}

/**
 * A listing failed. The third in a row moves an `active` server to `error`,
 * which takes its tools out of the chat. Returns whether this call made that
 * move, so the caller raises one notice for it.
 */
export async function recordCheckFailure(serverId: string, code: string): Promise<{ readonly movedToError: boolean }> {
  const row = await queryOne<{ moved: boolean }>(
    `WITH prev AS (SELECT status FROM user_mcp_servers WHERE id = $1 FOR UPDATE)
     UPDATE user_mcp_servers s
        SET failures = s.failures + 1,
            status = CASE WHEN s.status = 'active' AND s.failures + 1 >= $3 THEN 'error' ELSE s.status END,
            last_checked_at = now(),
            last_error = left($2, 64),
            updated_at = now()
       FROM prev
      WHERE s.id = $1
     RETURNING (prev.status = 'active' AND s.status = 'error') AS moved`,
    [serverId, code, FAILURES_BEFORE_ERROR],
  );
  return { movedToError: row?.moved === true };
}

export interface RecheckOutcome {
  /** Tools turned off because the server changed them, by remote name. */
  readonly changed: readonly string[];
  /** Tools the server listed for the first time (stored off). */
  readonly added: readonly string[];
  /** The reviewed tool was re-pinned to what the server lists now. */
  readonly reviewed: boolean;
}

/**
 * Apply a good listing. A stored tool is DRIFTED when the server no longer
 * lists it, when its schema hash changed, or when it runs without asking and
 * the server no longer declares it read-only; a drifted tool is turned off
 * and stays off until the user reviews it. `reviewToolId` re-pins that one
 * drifted tool to what the server lists now, still off. A tool listed for the
 * first time is stored off. The server's failure count resets and an `error`
 * server is `active` again.
 */
export async function applyRecheck(
  serverId: string,
  listed: readonly ListedToolRecord[],
  reviewToolId: string | null = null,
): Promise<RecheckOutcome> {
  return withTransaction(async (client) => {
    const stored = await queryWith<ToolRow>(
      client,
      `SELECT ${TOOL_COLUMNS} FROM user_mcp_tools WHERE server_id = $1 FOR UPDATE`,
      [serverId],
    );
    const byName = new Map(listed.map((tool) => [tool.remoteName, tool]));
    const changed: string[] = [];
    let reviewed = false;
    for (const tool of stored) {
      const now = byName.get(tool.remote_name);
      if (tool.id === reviewToolId && tool.status === "drifted" && now !== undefined) {
        await executeWith(
          client,
          `UPDATE user_mcp_tools
              SET description = $2, input_schema = $3::jsonb, schema_hash = $4, read_only_hint = $5,
                  status = $6, unsupported_reason = $7, enabled = false, auto_run = false, updated_at = now()
            WHERE id = $1`,
          [
            tool.id,
            now.description,
            jsonb(now.inputSchema),
            now.schemaHash,
            now.readOnlyHint,
            now.unsupportedReason === null ? "active" : "unsupported",
            now.unsupportedReason,
          ],
        );
        reviewed = true;
        continue;
      }
      if (tool.status === "unsupported") {
        // Never callable; keep it current so a fixed schema becomes reviewable.
        if (now !== undefined && now.schemaHash !== tool.schema_hash) {
          await executeWith(
            client,
            `UPDATE user_mcp_tools
                SET description = $2, input_schema = $3::jsonb, schema_hash = $4, read_only_hint = $5,
                    status = $6, unsupported_reason = $7, updated_at = now()
              WHERE id = $1`,
            [
              tool.id,
              now.description,
              jsonb(now.inputSchema),
              now.schemaHash,
              now.readOnlyHint,
              now.unsupportedReason === null ? "active" : "unsupported",
              now.unsupportedReason,
            ],
          );
        }
        continue;
      }
      const drifted =
        now === undefined || now.schemaHash !== tool.schema_hash || (tool.auto_run && !now.readOnlyHint);
      if (drifted) {
        if (tool.status !== "drifted") {
          changed.push(tool.remote_name);
          await executeWith(
            client,
            `UPDATE user_mcp_tools
                SET status = 'drifted', enabled = false, auto_run = false, enabled_at = NULL, updated_at = now()
              WHERE id = $1`,
            [tool.id],
          );
        }
        continue;
      }
      if (tool.status === "active" && now.readOnlyHint !== tool.read_only_hint) {
        await executeWith(
          client,
          "UPDATE user_mcp_tools SET read_only_hint = $2, updated_at = now() WHERE id = $1",
          [tool.id, now.readOnlyHint],
        );
      }
    }
    const storedNames = new Set(stored.map((tool) => tool.remote_name));
    const added: string[] = [];
    for (const tool of listed) {
      if (storedNames.has(tool.remoteName)) continue;
      await insertTool(client, serverId, tool);
      added.push(tool.remoteName);
    }
    await executeWith(
      client,
      `UPDATE user_mcp_servers
          SET failures = 0, status = CASE WHEN status = 'error' THEN 'active' ELSE status END,
              last_checked_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [serverId],
    );
    return { changed, added, reviewed };
  });
}
