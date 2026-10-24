/**
 * The name a user MCP tool carries in front of the model: `mcp_t` plus the
 * first 16 hex digits of its row id.
 *
 * It is derived from the row, never from the server's own tool name, so a
 * server cannot choose a name that collides with a Vex tool. It holds no `__`,
 * so the injected protocol lane (`registry/injected-protocol-tools.ts`), which
 * claims every name with exactly one `__`, never claims it, and no internal
 * `ToolDef` name starts with lowercase `mcp_`.
 */

const NAME_PATTERN = /^mcp_t([0-9a-f]{16})$/;

export function userMcpToolName(rowId: string): string {
  return `mcp_t${rowId.replaceAll("-", "").toLowerCase().slice(0, 16)}`;
}

export function isUserMcpToolName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** The 16 hex digits a name carries, or `null` for any other name. */
export function userMcpToolNamePrefix(name: string): string | null {
  return NAME_PATTERN.exec(name)?.[1] ?? null;
}
