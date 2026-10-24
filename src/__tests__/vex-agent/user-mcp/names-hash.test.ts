import { describe, expect, it } from "vitest";
import { isUserMcpToolName, userMcpToolName, userMcpToolNamePrefix } from "@vex-agent/user-mcp/names.js";
import { canonicalJson, schemaHash } from "@vex-agent/user-mcp/hash.js";
import { isInjectedToolNameShape } from "@vex-agent/tools/registry/injected-protocol-tools.js";

describe("user MCP tool names", () => {
  const rowId = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";

  it("derives mcp_t plus 16 lowercase hex digits from the row id", () => {
    expect(userMcpToolName(rowId)).toBe("mcp_t3f2504e04f8911d3");
    expect(isUserMcpToolName(userMcpToolName(rowId))).toBe(true);
    expect(userMcpToolNamePrefix(userMcpToolName(rowId))).toBe("3f2504e04f8911d3");
  });

  it("is never claimed by the injected protocol lane and refuses lookalikes", () => {
    expect(isInjectedToolNameShape(userMcpToolName(rowId))).toBe(false);
    for (const name of ["mcp_t3f2504e04f8911d", "MCP_T3f2504e04f8911d3", "mcp_t3f2504e04f8911d3x", "mcp__t3f2504e04f8911d3", "web__fetch"]) {
      expect(isUserMcpToolName(name)).toBe(false);
      expect(userMcpToolNamePrefix(name)).toBeNull();
    }
  });
});

describe("schema hash", () => {
  it("ignores key order but not values", () => {
    const a = { type: "object", properties: { q: { type: "string" }, n: { type: "integer" } }, required: ["q"] };
    const b = { required: ["q"], properties: { n: { type: "integer" }, q: { type: "string" } }, type: "object" };
    expect(schemaHash(a)).toBe(schemaHash(b));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(schemaHash(a)).not.toBe(schemaHash({ ...a, required: ["n"] }));
    expect(schemaHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
