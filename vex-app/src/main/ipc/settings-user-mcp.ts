/**
 * Settings > Tools (MCP): the user's own MCP servers (F12).
 *
 * The only place trust over these tools is widened: adding a server, turning
 * a tool on, or letting it run without asking happens here and nowhere in
 * chat. Every handler waits for the engine database; every write answers with
 * the fresh list, so the section never shows a state main did not store.
 *
 * Tokens come in on `addUserMcpServer` and `setUserMcpToken`, go straight to
 * the vault (`secrets/user-mcp-token.ts`) and never come back out. A refusal
 * is a `validation.invalid_input` result whose message starts with the
 * refusal code and then says what to do, in words.
 */

import {
  getServer,
  listServersWithTools,
  removeServer,
  setServerHasToken,
  setToolAutoRun,
  setToolEnabled,
} from "@vex-agent/db/repos/user-mcp.js";
import { addServer, recheckServer } from "@vex-agent/user-mcp/store.js";
import { refreshUserMcpTools } from "@vex-agent/tools/user-mcp/admitted.js";
import { userMcpToolName } from "@vex-agent/user-mcp/names.js";
import { MAX_DISPLAY_SCHEMA_CHARS, MAX_ENABLED_TOOLS, MAX_SERVERS } from "@vex-agent/user-mcp/limits.js";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  addUserMcpServerInputSchema,
  listUserMcpInputSchema,
  recheckUserMcpServerInputSchema,
  removeUserMcpServerInputSchema,
  setUserMcpTokenInputSchema,
  setUserMcpToolAutoRunInputSchema,
  setUserMcpToolEnabledInputSchema,
  userMcpListDtoSchema,
  type UserMcpListDto,
} from "@shared/schemas/user-mcp.js";
import { whenEngineDbReady } from "../database/engine-db-readiness.js";
import { deleteUserMcpToken, UserMcpTokenLockedError, writeUserMcpToken } from "../secrets/user-mcp-token.js";
import { log } from "../logger/index.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  invalid_url: "That is not an address Vex can use. Paste the server's Streamable HTTP URL.",
  not_https: "Use https for a server on the internet. Plain http is only for a server on this computer.",
  credentials_in_url: "Take the user name and password out of the URL, and add a token instead.",
  fragment_in_url: "Take the # part out of the URL.",
  private_address: "That address is on a private or local network. Vex reaches servers on the internet or on this computer only.",
  blocked_address: "That name points to a private or local network address, so Vex will not connect to it.",
  cross_origin: "The server tried to send Vex somewhere else, so Vex stopped.",
  response_too_large: "The server's answer was too large.",
  unauthorized: "The server refused the token. Check it and try again.",
  timeout: "The server did not answer in time.",
  not_mcp: "The server did not answer like an MCP server.",
  unreachable: "Vex could not reach the server.",
  too_many_servers: `You can add up to ${MAX_SERVERS} servers.`,
  already_added: "That server is already added.",
  rate_limited: "Too many checks in a minute. Wait a moment and try again.",
  vault_locked: "Unlock Vex to use or change this server's token.",
  not_saved: "The server could not be saved. Try again.",
  not_found: "That server or tool is no longer there.",
  not_active: "That tool cannot be turned on: the server changed it, or Vex does not support what it takes.",
  server_not_active: "That server is not answering, so its tools are off. Check it again first.",
  cap_reached: `Up to ${MAX_ENABLED_TOOLS} tools can be in use at once. Turn one off first.`,
  not_read_only: "Only a tool its server declares read-only can run without asking.",
  not_enabled: "Turn the tool on before letting it run without asking.",
};

function refusal(ctx: HandlerContext, code: string): Result<never> {
  return err({
    code: "validation.invalid_input",
    domain: "settings",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId: ctx.requestId,
    message: `${code.toUpperCase()}: ${REFUSAL_COPY[code] ?? "That did not work. Try again."}`,
  });
}

function unexpected(ctx: HandlerContext): Result<never> {
  return err({
    code: "internal.unexpected",
    domain: "settings",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId: ctx.requestId,
    message: "The MCP server settings could not be read or saved.",
  });
}

export async function buildUserMcpList(): Promise<UserMcpListDto> {
  const entries = await listServersWithTools();
  let enabledCount = 0;
  const servers = entries.map(({ server, tools }) => ({
    id: server.id,
    name: server.name,
    endpoint: server.endpoint,
    networkScope: server.networkScope,
    hasToken: server.hasToken,
    status: server.status,
    lastCheckedAt: server.lastCheckedAt === null ? null : server.lastCheckedAt.toISOString(),
    lastError: server.lastError,
    tools: tools.map((tool) => {
      if (tool.enabled) enabledCount += 1;
      const json = JSON.stringify(tool.inputSchema, null, 2) ?? "{}";
      return {
        id: tool.id,
        modelName: userMcpToolName(tool.id),
        remoteName: tool.remoteName,
        description: tool.description,
        readOnlyHint: tool.readOnlyHint,
        enabled: tool.enabled,
        autoRun: tool.autoRun,
        status: tool.status,
        unsupportedReason: tool.unsupportedReason,
        schemaJson: json.length > MAX_DISPLAY_SCHEMA_CHARS ? `${json.slice(0, MAX_DISPLAY_SCHEMA_CHARS)}\n…` : json,
      };
    }),
  }));
  return { servers, enabledCount, maxEnabled: MAX_ENABLED_TOOLS, maxServers: MAX_SERVERS };
}

/** Wait for the engine database, run, answer the fresh list; any throw is `internal.unexpected`. */
async function withDb(
  ctx: HandlerContext,
  label: string,
  fn: () => Promise<Result<UserMcpListDto> | null>,
): Promise<Result<UserMcpListDto>> {
  try {
    await whenEngineDbReady({ signal: ctx.signal });
    const refused = await fn();
    if (refused !== null) return refused;
    // The engine offers tools from a snapshot; every Settings change replaces it.
    await refreshUserMcpTools();
    return ok(await buildUserMcpList());
  } catch (cause) {
    log.warn(`[ipc:vex:settings:${label}] failed correlationId=${ctx.requestId}`, cause instanceof Error ? cause.name : "non_error");
    return unexpected(ctx);
  }
}

export function registerUserMcpSettingsHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.settings.listUserMcp,
      domain: "settings",
      inputSchema: listUserMcpInputSchema,
      outputSchema: userMcpListDtoSchema,
      handle: (_input, ctx) => withDb(ctx, "listUserMcp", async () => null),
    }),
    registerHandler({
      channel: CH.settings.addUserMcpServer,
      domain: "settings",
      inputSchema: addUserMcpServerInputSchema,
      outputSchema: userMcpListDtoSchema,
      handle: (input, ctx) =>
        withDb(ctx, "addUserMcpServer", async () => {
          const outcome = await addServer(
            { name: input.name, endpoint: input.endpoint, token: input.token },
            { writeToken: (id, token) => writeUserMcpToken(id, token), deleteToken: (id) => deleteUserMcpToken(id) },
          );
          if (!outcome.ok) return refusal(ctx, outcome.reason);
          log.info(
            `[ipc:vex:settings:addUserMcpServer] added tools=${outcome.tools} unsupported=${outcome.unsupported} correlationId=${ctx.requestId}`,
          );
          return null;
        }),
    }),
    registerHandler({
      channel: CH.settings.removeUserMcpServer,
      domain: "settings",
      inputSchema: removeUserMcpServerInputSchema,
      outputSchema: userMcpListDtoSchema,
      handle: ({ serverId }, ctx) =>
        withDb(ctx, "removeUserMcpServer", async () => {
          const server = await getServer(serverId);
          if (server === null) return refusal(ctx, "not_found");
          if (server.hasToken) {
            // The vault entry goes first: a removed server never leaves its
            // token behind, so removal waits for an unlocked vault.
            try {
              await deleteUserMcpToken(serverId);
            } catch (cause) {
              if (cause instanceof UserMcpTokenLockedError) return refusal(ctx, "vault_locked");
              throw cause;
            }
          }
          await removeServer(serverId);
          return null;
        }),
    }),
    registerHandler({
      channel: CH.settings.setUserMcpToken,
      domain: "settings",
      inputSchema: setUserMcpTokenInputSchema,
      outputSchema: userMcpListDtoSchema,
      handle: ({ serverId, token }, ctx) =>
        withDb(ctx, "setUserMcpToken", async () => {
          if ((await getServer(serverId)) === null) return refusal(ctx, "not_found");
          try {
            await writeUserMcpToken(serverId, token);
          } catch (cause) {
            if (cause instanceof UserMcpTokenLockedError) return refusal(ctx, "vault_locked");
            throw cause;
          }
          await setServerHasToken(serverId, token !== null);
          return null;
        }),
    }),
    registerHandler({
      channel: CH.settings.setUserMcpToolEnabled,
      domain: "settings",
      inputSchema: setUserMcpToolEnabledInputSchema,
      outputSchema: userMcpListDtoSchema,
      handle: ({ toolId, enabled }, ctx) =>
        withDb(ctx, "setUserMcpToolEnabled", async () => {
          const outcome = await setToolEnabled(toolId, enabled);
          return outcome.ok ? null : refusal(ctx, outcome.reason);
        }),
    }),
    registerHandler({
      channel: CH.settings.setUserMcpToolAutoRun,
      domain: "settings",
      inputSchema: setUserMcpToolAutoRunInputSchema,
      outputSchema: userMcpListDtoSchema,
      handle: ({ toolId, autoRun }, ctx) =>
        withDb(ctx, "setUserMcpToolAutoRun", async () => {
          const outcome = await setToolAutoRun(toolId, autoRun);
          return outcome.ok ? null : refusal(ctx, outcome.reason);
        }),
    }),
    registerHandler({
      channel: CH.settings.recheckUserMcpServer,
      domain: "settings",
      inputSchema: recheckUserMcpServerInputSchema,
      outputSchema: userMcpListDtoSchema,
      handle: ({ serverId, reviewToolId }, ctx) =>
        withDb(ctx, "recheckUserMcpServer", async () => {
          const outcome = await recheckServer(serverId, { reviewToolId: reviewToolId ?? null, fromSettings: true });
          return outcome.ok ? null : refusal(ctx, outcome.reason);
        }),
    }),
  ];
}
