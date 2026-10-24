/**
 * Integration: migration 183 and the user MCP repo against real Postgres.
 *
 * The trust rules are held twice, in code and in CHECK constraints; only a
 * real database can show the constraints refuse what the code must never do.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { execute } from "@vex-agent/db/client.js";
import {
  applyRecheck,
  dueServers,
  getCallableToolByNamePrefix,
  insertServerWithTools,
  listCallableTools,
  listServersWithTools,
  recordCheckFailure,
  removeServer,
  setToolAutoRun,
  setToolEnabled,
  type ListedToolRecord,
} from "@vex-agent/db/repos/user-mcp.js";
import { MAX_ENABLED_TOOLS } from "@vex-agent/user-mcp/limits.js";
import { userMcpToolName, userMcpToolNamePrefix } from "@vex-agent/user-mcp/names.js";
import { resetDb } from "../setup/fixtures.js";

beforeEach(async () => {
  await resetDb();
});

function tool(name: string, over: Partial<ListedToolRecord> = {}): ListedToolRecord {
  return {
    remoteName: name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    schemaHash: `hash-${name}`,
    readOnlyHint: false,
    unsupportedReason: null,
    ...over,
  };
}

async function addServer(tools: readonly ListedToolRecord[], endpoint = `https://mcp-${randomUUID()}.example/mcp`) {
  const id = randomUUID();
  await insertServerWithTools({ id, name: "Docs", endpoint, networkScope: "public", hasToken: false, tools });
  const [entry] = (await listServersWithTools()).filter((e) => e.server.id === id);
  return { id, tools: entry!.tools };
}

const byName = (tools: readonly { remoteName: string; id: string }[], name: string) => tools.find((t) => t.remoteName === name)!;

describe("user_mcp tables (migration 183)", () => {
  it("stores a server with every tool off, and an unsupported tool as unsupported", async () => {
    const { tools } = await addServer([tool("search"), tool("weird", { unsupportedReason: "input: \"oneOf\" is not supported" })]);
    expect(tools.every((t) => !t.enabled && !t.autoRun)).toBe(true);
    expect(byName(tools, "weird")).toMatchObject({ status: "unsupported" });
    expect(await listCallableTools()).toEqual([]);
  });

  it("the CHECKs refuse auto_run without the read-only hint and enabled without active", async () => {
    const { tools } = await addServer([tool("write"), tool("weird", { unsupportedReason: "nope" })]);
    await expect(execute("UPDATE user_mcp_tools SET auto_run = true WHERE id = $1", [byName(tools, "write").id])).rejects.toThrow(
      /user_mcp_tools_auto_run_check/,
    );
    await expect(execute("UPDATE user_mcp_tools SET enabled = true WHERE id = $1", [byName(tools, "weird").id])).rejects.toThrow(
      /user_mcp_tools_enabled_check/,
    );
  });

  it("turns tools on up to the cap, refuses unsupported ones, and clears auto-run when turned off", async () => {
    const names = Array.from({ length: MAX_ENABLED_TOOLS + 1 }, (_, i) => `t${i}`);
    const { tools } = await addServer([...names.map((n) => tool(n, { readOnlyHint: true })), tool("weird", { unsupportedReason: "x" })]);
    for (const name of names.slice(0, MAX_ENABLED_TOOLS)) {
      expect(await setToolEnabled(byName(tools, name).id, true)).toEqual({ ok: true });
    }
    expect(await setToolEnabled(byName(tools, names[MAX_ENABLED_TOOLS]!).id, true)).toEqual({ ok: false, reason: "cap_reached" });
    expect(await setToolEnabled(byName(tools, "weird").id, true)).toEqual({ ok: false, reason: "not_active" });

    const t0 = byName(tools, "t0").id;
    expect(await setToolAutoRun(t0, true)).toEqual({ ok: true });
    expect(await setToolEnabled(t0, false)).toEqual({ ok: true });
    const after = (await listServersWithTools())[0]!.tools;
    expect(byName(after, "t0")).toMatchObject({ enabled: false, autoRun: false });
  });

  it("the cap holds under concurrent turn-ons", async () => {
    const names = Array.from({ length: MAX_ENABLED_TOOLS + 4 }, (_, i) => `c${i}`);
    const { tools } = await addServer(names.map((n) => tool(n)));
    const outcomes = await Promise.all(names.map((n) => setToolEnabled(byName(tools, n).id, true)));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(MAX_ENABLED_TOOLS);
    expect(await listCallableTools(100)).toHaveLength(MAX_ENABLED_TOOLS);
  });

  it("auto-run needs the read-only hint and the tool on", async () => {
    const { tools } = await addServer([tool("read", { readOnlyHint: true }), tool("write")]);
    expect(await setToolAutoRun(byName(tools, "read").id, true)).toEqual({ ok: false, reason: "not_enabled" });
    await setToolEnabled(byName(tools, "write").id, true);
    expect(await setToolAutoRun(byName(tools, "write").id, true)).toEqual({ ok: false, reason: "not_read_only" });
    await setToolEnabled(byName(tools, "read").id, true);
    expect(await setToolAutoRun(byName(tools, "read").id, true)).toEqual({ ok: true });
  });

  it("resolves a callable tool by its model name, and not once it is off or its server fails", async () => {
    const { id: serverId, tools } = await addServer([tool("search", { readOnlyHint: true })]);
    const toolId = byName(tools, "search").id;
    const prefix = userMcpToolNamePrefix(userMcpToolName(toolId))!;
    expect(await getCallableToolByNamePrefix(prefix)).toBeNull();
    await setToolEnabled(toolId, true);
    expect(await getCallableToolByNamePrefix(prefix)).toMatchObject({ toolId, serverId, remoteName: "search", serverName: "Docs" });

    for (let i = 0; i < 2; i++) expect(await recordCheckFailure(serverId, "unreachable")).toEqual({ movedToError: false });
    expect(await recordCheckFailure(serverId, "unreachable")).toEqual({ movedToError: true });
    expect(await getCallableToolByNamePrefix(prefix)).toBeNull();
    expect(await recordCheckFailure(serverId, "unreachable")).toEqual({ movedToError: false });

    await applyRecheck(serverId, [tool("search", { readOnlyHint: true })]);
    expect(await getCallableToolByNamePrefix(prefix)).toMatchObject({ toolId });
    expect(await getCallableToolByNamePrefix("nothex")).toBeNull();
  });

  it("drift turns a changed, removed or no-longer-read-only auto-run tool off; review re-pins it off", async () => {
    const { id: serverId, tools } = await addServer([
      tool("changed", { readOnlyHint: true }),
      tool("gone"),
      tool("lost_hint", { readOnlyHint: true }),
      tool("same"),
    ]);
    for (const t of tools) await setToolEnabled(t.id, true);
    await setToolAutoRun(byName(tools, "lost_hint").id, true);

    const outcome = await applyRecheck(serverId, [
      tool("changed", { readOnlyHint: true, schemaHash: "hash-changed-v2" }),
      tool("lost_hint", { readOnlyHint: false }),
      tool("same"),
      tool("brand_new"),
    ]);
    expect([...outcome.changed].sort()).toEqual(["changed", "gone", "lost_hint"]);
    expect(outcome.added).toEqual(["brand_new"]);

    const after = (await listServersWithTools())[0]!.tools;
    for (const name of ["changed", "gone", "lost_hint"]) {
      expect(byName(after, name)).toMatchObject({ status: "drifted", enabled: false, autoRun: false });
    }
    expect(byName(after, "same")).toMatchObject({ status: "active", enabled: true });
    expect(byName(after, "brand_new")).toMatchObject({ status: "active", enabled: false });

    const again = await applyRecheck(
      serverId,
      [tool("changed", { readOnlyHint: true, schemaHash: "hash-changed-v2" }), tool("lost_hint"), tool("same"), tool("brand_new")],
      byName(after, "changed").id,
    );
    expect(again.reviewed).toBe(true);
    expect(again.changed).toEqual([]);
    const reviewed = byName((await listServersWithTools())[0]!.tools, "changed");
    expect(reviewed).toMatchObject({ status: "active", enabled: false, schemaHash: "hash-changed-v2" });
  });

  it("lists due servers and removes a server with its tools", async () => {
    const { id: serverId } = await addServer([tool("search")]);
    expect(await dueServers(50, 60_000)).toEqual([]);
    await execute("UPDATE user_mcp_servers SET last_checked_at = now() - interval '7 hours' WHERE id = $1", [serverId]);
    expect((await dueServers()).map((s) => s.id)).toEqual([serverId]);
    expect(await removeServer(serverId)).toBe(true);
    expect(await listServersWithTools()).toEqual([]);
    expect(await removeServer(serverId)).toBe(false);
  });

  it("refuses a second server on the same endpoint", async () => {
    await addServer([], "https://same.example/mcp");
    await expect(addServer([], "https://same.example/mcp")).rejects.toThrow();
  });
});
