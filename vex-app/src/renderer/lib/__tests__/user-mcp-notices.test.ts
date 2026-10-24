import { describe, expect, it } from "vitest";
import { userMcpNoticeMessage } from "../user-mcp-notices.js";

const base = { serverId: "11111111-2222-4333-8444-555555555555", serverName: "Docs" };

describe("userMcpNoticeMessage", () => {
  it("names the changed tools and where to review them", () => {
    expect(userMcpNoticeMessage({ ...base, tools: ["lookup", "search"], reason: "changed" })).toEqual({
      title: "MCP tools changed",
      message: "Docs changed lookup, search. They are off until you review them in Settings > Tools (MCP).",
    });
  });

  it("caps a long list", () => {
    const tools = Array.from({ length: 8 }, (_, i) => `t${i}`);
    expect(userMcpNoticeMessage({ ...base, tools, reason: "changed" }).message).toContain("t4 and 3 more");
  });

  it("says when a server stopped answering", () => {
    expect(userMcpNoticeMessage({ ...base, tools: [], reason: "not_answering" }).title).toBe("MCP server not answering");
  });
});
