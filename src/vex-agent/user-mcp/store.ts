/**
 * Adding and rechecking the user's own MCP servers (F12): the one place a
 * listing becomes stored rows, shared by the Settings IPC and the recheck
 * worker.
 *
 * ADD. The endpoint is checked, then the server's tools are listed ONCE
 * through the guarded client with the token held in memory, before anything
 * is stored: a wrong URL, a wrong token or a server that does not speak MCP is
 * refused at once. Only after a good listing is the token written to the vault
 * and the rows inserted, every tool off. If the insert fails, the vault entry
 * is removed again.
 *
 * RECHECK. A good listing is applied with the drift rules
 * (`applyRecheck`); a failed one counts toward `error`. A server whose token
 * cannot be read (vault locked) is skipped WITHOUT touching its failure count.
 *
 * Adds and rechecks share an in-memory window of `ADMIN_OPS_PER_MINUTE`, so a
 * hurried user cannot turn Settings into a request loop against a server.
 */

import { randomUUID } from "node:crypto";
import {
  applyRecheck,
  countServers,
  getServer,
  insertServerWithTools,
  recordCheckFailure,
  serverWithEndpointExists,
  type ListedToolRecord,
  type RecheckOutcome,
  type UserMcpServer,
} from "@vex-agent/db/repos/user-mcp.js";
import { listRemoteTools, UserMcpOperationError, type ClientOptions, type RemoteTool } from "./client.js";
import { checkEndpoint, type UserMcpRefusalCode } from "./egress.js";
import { schemaHash } from "./hash.js";
import { ADMIN_OPS_PER_MINUTE, MAX_SERVERS, MAX_STORED_DESCRIPTION_CHARS } from "./limits.js";
import { convertInputSchema } from "./schema.js";
import { readUserMcpToken } from "./token-reader.js";

/** Turn a listing into rows: the schema checked, hashed and pinned. */
export function toListedRecords(tools: readonly RemoteTool[]): ListedToolRecord[] {
  return tools.map((tool) => {
    const converted = convertInputSchema(tool.inputSchema);
    return {
      remoteName: tool.name,
      description: tool.description.slice(0, MAX_STORED_DESCRIPTION_CHARS),
      inputSchema: tool.inputSchema,
      schemaHash: schemaHash(tool.inputSchema),
      readOnlyHint: tool.readOnlyHint,
      unsupportedReason: converted.ok ? null : converted.reason,
    };
  });
}

// ── The admin window ─────────────────────────────────────────────

let adminOps: number[] = [];

function takeAdminSlot(now = Date.now()): boolean {
  adminOps = adminOps.filter((at) => now - at < 60_000);
  if (adminOps.length >= ADMIN_OPS_PER_MINUTE) return false;
  adminOps.push(now);
  return true;
}

export function __resetUserMcpAdminWindowForTests(): void {
  adminOps = [];
}

// ── Add ──────────────────────────────────────────────────────────

export type AddServerRefusal =
  | UserMcpRefusalCode
  | "too_many_servers"
  | "already_added"
  | "rate_limited"
  | "vault_locked"
  | "not_saved";

export type AddServerOutcome =
  | { readonly ok: true; readonly serverId: string; readonly tools: number; readonly unsupported: number }
  | { readonly ok: false; readonly reason: AddServerRefusal };

export interface AddServerDeps {
  /** Write the token to the vault; throws while the vault is locked. */
  readonly writeToken: (serverId: string, token: string) => Promise<void>;
  /** Remove the vault entry (cleanup when the insert fails). */
  readonly deleteToken: (serverId: string) => Promise<void>;
  readonly client?: ClientOptions;
  readonly newId?: () => string;
}

export async function addServer(
  input: { readonly name: string; readonly endpoint: string; readonly token: string | null },
  deps: AddServerDeps,
): Promise<AddServerOutcome> {
  const checked = checkEndpoint(input.endpoint);
  if (!checked.ok) return { ok: false, reason: checked.code };
  if ((await countServers()) >= MAX_SERVERS) return { ok: false, reason: "too_many_servers" };
  if (await serverWithEndpointExists(checked.endpoint)) return { ok: false, reason: "already_added" };
  if (!takeAdminSlot()) return { ok: false, reason: "rate_limited" };

  const token = input.token !== null && input.token.trim().length > 0 ? input.token.trim() : null;
  let remote: readonly RemoteTool[];
  try {
    remote = await listRemoteTools(
      { endpoint: checked.endpoint, networkScope: checked.networkScope, token },
      deps.client,
    );
  } catch (error) {
    return { ok: false, reason: error instanceof UserMcpOperationError ? error.code : "unreachable" };
  }

  const serverId = (deps.newId ?? randomUUID)();
  if (token !== null) {
    try {
      await deps.writeToken(serverId, token);
    } catch {
      return { ok: false, reason: "vault_locked" };
    }
  }
  const records = toListedRecords(remote);
  try {
    await insertServerWithTools({
      id: serverId,
      name: input.name.trim(),
      endpoint: checked.endpoint,
      networkScope: checked.networkScope,
      hasToken: token !== null,
      tools: records,
    });
  } catch {
    if (token !== null) await deps.deleteToken(serverId).catch(() => undefined);
    return { ok: false, reason: "not_saved" };
  }
  return {
    ok: true,
    serverId,
    tools: records.length,
    unsupported: records.filter((r) => r.unsupportedReason !== null).length,
  };
}

// ── Recheck ──────────────────────────────────────────────────────

export type RecheckServerOutcome =
  | ({ readonly ok: true; readonly server: UserMcpServer } & RecheckOutcome)
  | {
      readonly ok: false;
      readonly reason: UserMcpRefusalCode | "not_found" | "vault_locked" | "rate_limited";
      /** This failure moved the server to `error`. */
      readonly movedToError?: boolean;
    };

/**
 * Read a server's tool list again and apply it. `fromSettings` charges the
 * admin window (the worker does not); `reviewToolId` re-pins one drifted tool.
 */
export async function recheckServer(
  serverId: string,
  options: { readonly reviewToolId?: string | null; readonly fromSettings?: boolean; readonly client?: ClientOptions } = {},
): Promise<RecheckServerOutcome> {
  const server = await getServer(serverId);
  if (server === null) return { ok: false, reason: "not_found" };
  if (options.fromSettings === true && !takeAdminSlot()) return { ok: false, reason: "rate_limited" };
  const read = await readUserMcpToken(server.id, server.hasToken);
  if (read.kind === "locked") return { ok: false, reason: "vault_locked" };
  let remote: readonly RemoteTool[];
  try {
    remote = await listRemoteTools(
      { endpoint: server.endpoint, networkScope: server.networkScope, token: read.kind === "token" ? read.token : null },
      options.client,
    );
  } catch (error) {
    const code = error instanceof UserMcpOperationError ? error.code : "unreachable";
    const { movedToError } = await recordCheckFailure(server.id, code);
    return { ok: false, reason: code, movedToError };
  }
  const outcome = await applyRecheck(server.id, toListedRecords(remote), options.reviewToolId ?? null);
  const after = await getServer(server.id);
  return { ok: true, server: after ?? server, ...outcome };
}
