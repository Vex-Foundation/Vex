/**
 * The user MCP client against a REAL `McpServer` over Streamable HTTP on
 * loopback (protocol guardrail; the live public-server check is separate).
 */

import { afterEach, describe, expect, it } from "vitest";
import { callRemoteTool, listRemoteTools, UserMcpOperationError } from "@vex-agent/user-mcp/client.js";
import { MAX_RESULT_CHARS, MAX_TOOLS_PER_SERVER } from "@vex-agent/user-mcp/limits.js";
import { startTestMcpServer, type TestMcpServer } from "./fixtures/mcp-test-server.js";
import { requireValue } from "../../helpers/require-value.js";

let server: TestMcpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const local = (url: string, token: string | null = null) => ({ endpoint: url, networkScope: "local" as const, token });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserMcpOperationError) return error.code;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("listRemoteTools", () => {
  it("lists the tools with their schemas and the read-only hint", async () => {
    server = await startTestMcpServer();
    const tools = await listRemoteTools(local(server.url));
    expect(tools.map((t) => t.name).sort()).toEqual(["big", "fails", "lookup", "write_note"]);
    const lookup = requireValue(tools.find((t) => t.name === "lookup"));
    expect(lookup).toMatchObject({ description: "Look a word up", readOnlyHint: true });
    expect(lookup.inputSchema).toMatchObject({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    expect(requireValue(tools.find((t) => t.name === "write_note")).readOnlyHint).toBe(false);
  });

  it(`stops at ${MAX_TOOLS_PER_SERVER} tools`, async () => {
    server = await startTestMcpServer({ state: { extraTools: 150 } });
    expect(await listRemoteTools(local(server.url))).toHaveLength(MAX_TOOLS_PER_SERVER);
  });

  it("sends the bearer token, and refuses a missing or wrong one as unauthorized", async () => {
    server = await startTestMcpServer({ token: "s3cret" });
    expect(await codeOf(listRemoteTools(local(server.url)))).toBe("unauthorized");
    expect(await codeOf(listRemoteTools(local(server.url, "wrong")))).toBe("unauthorized");
    const tools = await listRemoteTools(local(server.url, "s3cret"));
    expect(tools.length).toBeGreaterThan(0);
    expect(server.requests.filter((r) => r.authorized).every((r) => r.authorization === "Bearer s3cret")).toBe(true);
  });

  it("answers unreachable for a closed port", async () => {
    server = await startTestMcpServer();
    const url = server.url;
    await server.close();
    server = null;
    expect(await codeOf(listRemoteTools(local(url), { timeoutMs: 5_000 }))).toBe("unreachable");
  });
});

describe("callRemoteTool", () => {
  it("returns the text the server produced", async () => {
    server = await startTestMcpServer();
    expect(await callRemoteTool(local(server.url), "lookup", { q: "vex" })).toEqual({
      isError: false,
      text: 'found: {"q":"vex"}',
      truncated: false,
    });
  });

  it(`cuts a long result to ${MAX_RESULT_CHARS} characters`, async () => {
    server = await startTestMcpServer();
    const result = await callRemoteTool(local(server.url), "big", { size: MAX_RESULT_CHARS + 5_000 });
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(MAX_RESULT_CHARS);
  });

  it("reports a server-side error result as isError", async () => {
    server = await startTestMcpServer();
    expect(await callRemoteTool(local(server.url), "fails", {})).toEqual({
      isError: true,
      text: "the upstream index is down",
      truncated: false,
    });
  });
});
