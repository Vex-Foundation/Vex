/**
 * The user's own MCP tools are NEVER offered to coding agents through the
 * Studio MCP server (F12 hard rule): not listed, not admitted, and nothing
 * under `src/vex-agent/mcp/` even imports the feature.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { admitStudioCall } from "@vex-agent/mcp/admission.js";
import { isExportedInternalTool, listExportedTools } from "@vex-agent/mcp/export-scope.js";
import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import { userMcpToolName } from "@vex-agent/user-mcp/names.js";
import { makeTestContext } from "../tools/_test-context.js";

const NAME = userMcpToolName("3f2504e0-4f89-41d3-9a0c-0305e82c3301");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("user MCP tools and Studio", () => {
  it("are not exported and not in the Studio inventory", () => {
    expect(isExportedInternalTool(NAME)).toBe(false);
    expect(JSON.stringify(listExportedTools())).not.toMatch(/mcp_t[0-9a-f]{16}/);
    expect(buildStudioInventory().some((tool) => /^mcp_t/.test(tool.publicName))).toBe(false);
  });

  it("a Studio call by that name gets the unknown-tool refusal and is never dispatched", async () => {
    const { result, dispatched } = await admitStudioCall(
      { name: NAME, args: { q: "x" }, toolCallId: "studio-1" },
      makeTestContext({ sessionPermission: "full", approved: true }),
    );
    expect(dispatched).toBe(false);
    expect(result.success).toBe(false);
  });

  it("nothing in the Studio server imports the user MCP feature", () => {
    for (const file of filesUnder("src/vex-agent/mcp")) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/user-mcp\//);
    }
  });
});
