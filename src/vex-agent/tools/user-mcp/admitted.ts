/**
 * The user MCP tools offered to the model (F12): an in-memory snapshot of
 * the callable tools, and the projection `getOpenAITools` appends.
 *
 * `getOpenAITools` is synchronous and re-runs every round, so it reads this
 * snapshot instead of the database. The snapshot is loaded when the recheck
 * worker starts and replaced by `refreshUserMcpTools()` after every Settings
 * write and every recheck tick. THE DISPATCHER NEVER TRUSTS IT: a call re-reads
 * its row (`route.ts`), so a tool turned off between the snapshot and the call
 * is refused.
 *
 * Offered only in interactive agent sessions, never in a mission run (a card
 * per call would park an autonomous run), at most `MAX_ENABLED_TOOLS`, oldest
 * turned-on first. Each description is labelled third-party.
 */

import { MAX_ENABLED_TOOLS, MAX_MODEL_DESCRIPTION_CHARS } from "@vex-agent/user-mcp/limits.js";
import { userMcpToolName } from "@vex-agent/user-mcp/names.js";
import { convertInputSchema } from "@vex-agent/user-mcp/schema.js";
import type { JsonSchema, OpenAITool } from "../types.js";
import type { ToolVisibilityContext } from "../registry/visibility.js";
import logger from "@utils/logger.js";

export interface AdmittedUserMcpTool {
  readonly name: string;
  readonly toolId: string;
  readonly serverName: string;
  readonly remoteName: string;
  readonly description: string;
  readonly modelSchema: JsonSchema;
}

let snapshot: readonly AdmittedUserMcpTool[] = [];

export function userMcpToolDescription(serverName: string, remoteName: string, description: string): string {
  const head = `Tool "${remoteName}" on the user's own MCP server "${serverName}" (third-party, untrusted)`;
  const body = description.trim().slice(0, MAX_MODEL_DESCRIPTION_CHARS);
  return body.length > 0 ? `${head}: ${body}` : `${head}.`;
}

/** Reload the snapshot from the database. Never throws: a failed read keeps the last one. */
export async function refreshUserMcpTools(): Promise<readonly AdmittedUserMcpTool[]> {
  try {
    // Dynamic, as the protocol runtime reads the database: no static tool → DB edge.
    const { listCallableTools } = await import("@vex-agent/db/repos/user-mcp.js");
    const rows = await listCallableTools(MAX_ENABLED_TOOLS);
    const next: AdmittedUserMcpTool[] = [];
    for (const row of rows) {
      const converted = convertInputSchema(row.inputSchema);
      if (!converted.ok) continue;
      next.push({
        name: userMcpToolName(row.toolId),
        toolId: row.toolId,
        serverName: row.serverName,
        remoteName: row.remoteName,
        description: userMcpToolDescription(row.serverName, row.remoteName, row.description),
        modelSchema: converted.modelSchema,
      });
    }
    snapshot = next;
  } catch (error) {
    logger.warn("user_mcp.snapshot_refresh_failed", { error: error instanceof Error ? error.name : "non_error" });
  }
  return snapshot;
}

export function getAdmittedUserMcpTools(): readonly AdmittedUserMcpTool[] {
  return snapshot;
}

/** The same predicate gates the tools block and the prompt line. */
export function userMcpToolsOffered(ctx: Pick<ToolVisibilityContext, "sessionKind" | "missionRunActive">): boolean {
  return ctx.sessionKind === "agent" && !ctx.missionRunActive && snapshot.length > 0;
}

export function buildUserMcpTools(ctx: Pick<ToolVisibilityContext, "sessionKind" | "missionRunActive">): OpenAITool[] {
  if (!userMcpToolsOffered(ctx)) return [];
  return snapshot.slice(0, MAX_ENABLED_TOOLS).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.modelSchema },
  }));
}

export function __setUserMcpSnapshotForTests(next: readonly AdmittedUserMcpTool[]): void {
  snapshot = next;
}
