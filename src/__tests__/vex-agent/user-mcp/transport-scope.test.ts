/**
 * The user MCP client is Streamable HTTP only: no file of the feature may
 * import the stdio transport (it spawns a process) or the SSE client.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/vex-agent/user-mcp", "src/vex-agent/tools/user-mcp"];

function filesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("user MCP transport scope", () => {
  it("imports neither the stdio transport nor the SSE client", () => {
    const files = ROOTS.flatMap(filesUnder);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/@modelcontextprotocol\/client\/stdio/);
      expect(text, file).not.toMatch(/SSEClientTransport|StdioClientTransport|node:child_process/);
    }
  });
});
