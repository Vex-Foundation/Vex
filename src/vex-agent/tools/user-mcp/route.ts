/**
 * The lane that runs a user MCP tool (F12): `routeToolCall` sends every
 * `mcp_t<16 hex>` name here, before the injected protocol lane.
 *
 * READ-ONLY BY CONSTRUCTION. A user MCP tool is neither a `ToolDef` nor a
 * protocol manifest: it cannot prepare an intent, reach a signer, or appear in
 * Studio. Its result is text in an `untrusted: true` envelope and its
 * `actionKind` is always `read`.
 *
 * EVERY CALL, IN ORDER:
 *  1. refused outside an interactive agent session or inside a mission run;
 *  2. the row is RE-READ (`getCallableToolByNamePrefix`): a tool turned off,
 *     drifted, removed, or on a server in `error` refuses by name, also when
 *     an approval resumes;
 *  3. the arguments are checked by the strict validator rebuilt from the
 *     PINNED schema; an undeclared key is refused;
 *  4. unless the tool runs without asking or this is an approved resume, the
 *     call stops on an approval card, in Restricted AND Full access, and the
 *     card names the server, the tool and the exact arguments;
 *  5. a slot in the 30-a-minute window, the token through the vault seam
 *     (locked fails closed), and the call. Only the validated arguments leave:
 *     no session, wallet or approval id.
 */

import { callRemoteTool, UserMcpOperationError } from "@vex-agent/user-mcp/client.js";
import { CALLS_PER_MINUTE, MAX_PREVIEW_ARGUMENT_CHARS } from "@vex-agent/user-mcp/limits.js";
import { userMcpToolNamePrefix } from "@vex-agent/user-mcp/names.js";
import { convertInputSchema } from "@vex-agent/user-mcp/schema.js";
import { readUserMcpToken } from "@vex-agent/user-mcp/token-reader.js";
import type { InternalToolContext } from "../internal/types.js";
import type { ToolCallRequest, ToolResult } from "../types.js";
import logger from "@utils/logger.js";

const FAILURE_COPY: Readonly<Record<string, string>> = {
  unauthorized: "the server refused the saved token",
  timeout: "the server did not answer in time",
  unreachable: "Vex could not reach the server",
  blocked_address: "the server's address is on a private network, so Vex did not connect",
  response_too_large: "the server's answer was too large",
  cross_origin: "the server tried to send Vex somewhere else",
  not_mcp: "the server did not answer like an MCP server",
};

let calls: number[] = [];

function takeCallSlot(now = Date.now()): boolean {
  calls = calls.filter((at) => now - at < 60_000);
  if (calls.length >= CALLS_PER_MINUTE) return false;
  calls.push(now);
  return true;
}

export function __resetUserMcpCallWindowForTests(): void {
  calls = [];
}

function refuse(output: string): ToolResult {
  return { success: false, output, actionKind: "read" };
}

/** `arguments` for the approval card: exact JSON, cut with a marker. */
export function previewArguments(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > MAX_PREVIEW_ARGUMENT_CHARS ? `${json.slice(0, MAX_PREVIEW_ARGUMENT_CHARS)}… (cut)` : json;
}

export async function routeUserMcpTool(call: ToolCallRequest, context: InternalToolContext): Promise<ToolResult> {
  if (context.sessionKind !== "agent" || context.missionRunId !== null) {
    return refuse(`${call.name} is one of the user's own MCP tools; they run only in an interactive chat, not here.`);
  }
  const prefix = userMcpToolNamePrefix(call.name);
  // Dynamic, as the protocol runtime reads the database: no static tool → DB edge.
  const { getCallableToolByNamePrefix } = await import("@vex-agent/db/repos/user-mcp.js");
  const tool = prefix === null ? null : await getCallableToolByNamePrefix(prefix);
  if (tool === null) {
    return refuse(
      `${call.name} is not available: the user turned it off, its server changed it, or its server is not answering. ` +
        "Do not call it again in this turn.",
    );
  }
  const label = `${tool.serverName} / ${tool.remoteName}`;

  const converted = convertInputSchema(tool.inputSchema);
  if (!converted.ok) return refuse(`${label} cannot be called: Vex does not support what it takes.`);
  const parsed = converted.validator.safeParse(call.args);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "(arguments)"))
      .join(", ");
    return refuse(`${label} refused these arguments (check: ${where}). Use only the fields its schema declares.`);
  }
  const args = parsed.data;

  if (!tool.autoRun && context.approved !== true) {
    return {
      success: false,
      pendingApproval: true,
      actionKind: "read",
      externalToolPreview: { server: tool.serverName, tool: tool.remoteName, argumentsJson: previewArguments(args) },
      output: `${label} needs the user's approval before it runs.`,
    };
  }

  if (!takeCallSlot()) return refuse(`${label} was not called: too many MCP tool calls in the last minute.`);
  const token = await readUserMcpToken(tool.serverId, tool.hasToken);
  if (token.kind === "locked") return refuse(`${label} was not called: its token is in the vault, which is locked.`);

  try {
    const result = await callRemoteTool(
      { endpoint: tool.endpoint, networkScope: tool.networkScope, token: token.kind === "token" ? token.token : null },
      tool.remoteName,
      args,
      context.abortSignal === undefined ? {} : { signal: context.abortSignal },
    );
    const envelope = { server: tool.serverName, tool: tool.remoteName, untrusted: true, text: result.text, truncated: result.truncated };
    logger.info("user_mcp.call", { server: tool.serverId, tool: tool.toolId, isError: result.isError, truncated: result.truncated });
    return {
      success: !result.isError,
      actionKind: "read",
      output: JSON.stringify(result.isError ? { ...envelope, error: true } : envelope),
    };
  } catch (error) {
    // An operator Stop: the dispatcher reports it as a stop, not a failure.
    if (context.abortSignal?.aborted === true) {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", cause: error });
    }
    const code = error instanceof UserMcpOperationError ? error.code : "unreachable";
    logger.warn("user_mcp.call_failed", { server: tool.serverId, tool: tool.toolId, code });
    return refuse(`${label} failed: ${FAILURE_COPY[code] ?? "the call did not complete"}.`);
  }
}
