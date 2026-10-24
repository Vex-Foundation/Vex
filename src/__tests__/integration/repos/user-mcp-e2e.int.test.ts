/**
 * Integration, end to end with no model: a REAL `McpServer` over Streamable
 * HTTP on loopback (with a bearer token), REAL Postgres, the real store,
 * snapshot, dispatcher, and the real approval enqueue.
 *
 * add -> list -> turn on -> offered to the model -> call stops on a card
 * (an approval row with the exact arguments) -> approved resume returns the
 * server's text labelled untrusted -> auto-run only for the read-only tool ->
 * schema change turns the tool off and a resume refuses -> locked vault fails
 * closed -> remove leaves no vault entry.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryOne } from "@vex-agent/db/client.js";
import { listServersWithTools, removeServer, setToolAutoRun, setToolEnabled } from "@vex-agent/db/repos/user-mcp.js";
import { enqueueApprovalIntentWithGate } from "@vex-agent/engine/core/approval-runtime/enqueue.js";
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import { getOpenAITools } from "@vex-agent/tools/registry/openai-tools.js";
import { refreshUserMcpTools } from "@vex-agent/tools/user-mcp/admitted.js";
import { __resetUserMcpCallWindowForTests } from "@vex-agent/tools/user-mcp/route.js";
import { __resetUserMcpAdminWindowForTests, addServer, recheckServer } from "@vex-agent/user-mcp/store.js";
import { userMcpToolName } from "@vex-agent/user-mcp/names.js";
import { registerUserMcpTokenReader, type UserMcpTokenRead } from "@vex-agent/user-mcp/token-reader.js";
import { makeTestContext } from "../../vex-agent/tools/_test-context.js";
import { startTestMcpServer, type TestMcpServer } from "../../vex-agent/user-mcp/fixtures/mcp-test-server.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { requireValue } from "../../helpers/require-value.js";

let server: TestMcpServer;
let unregister: () => void;
const vault = new Map<string, string>();
let locked = false;

beforeEach(async () => {
  await resetDb();
  vault.clear();
  locked = false;
  __resetUserMcpAdminWindowForTests();
  __resetUserMcpCallWindowForTests();
  server = await startTestMcpServer({ token: "s3cret" });
  unregister = registerUserMcpTokenReader(async (id): Promise<UserMcpTokenRead> => {
    if (locked) return { kind: "locked" };
    const token = vault.get(id);
    return token === undefined ? { kind: "none" } : { kind: "token", token };
  });
});

afterEach(async () => {
  unregister();
  await server.close();
  await refreshUserMcpTools();
});

const agentCtx = { permission: "restricted" as const, sessionKind: "agent" as const, missionRunActive: false, planMode: false, contextUsageBand: "normal" as const, hasSessionMemory: false, preparationBypassesBarrier: false, hasCompactionSummaryReady: false };

describe("user MCP end to end", () => {
  it("adds, offers, asks, runs, drifts, fails closed and removes", async () => {
    // Add with the token; it goes to the vault, the tools are stored off.
    const added = await addServer(
      { name: "Docs", endpoint: server.url, token: "s3cret" },
      { writeToken: async (id, t) => void vault.set(id, t), deleteToken: async (id) => void vault.delete(id) },
    );
    if (!added.ok) throw new Error(`add failed: ${added.reason}`);
    expect(vault.get(added.serverId)).toBe("s3cret");
    const tools = requireValue((await listServersWithTools())[0]).tools;
    const lookup = requireValue(tools.find((t) => t.remoteName === "lookup"));
    const write = requireValue(tools.find((t) => t.remoteName === "write_note"));
    const name = userMcpToolName(lookup.id);

    // Nothing is offered until the user turns a tool on.
    await refreshUserMcpTools();
    expect(getOpenAITools(agentCtx).map((t) => t.function.name)).not.toContain(name);
    expect(await setToolEnabled(lookup.id, true)).toEqual({ ok: true });
    expect(await setToolEnabled(write.id, true)).toEqual({ ok: true });
    await refreshUserMcpTools();
    expect(getOpenAITools(agentCtx).map((t) => t.function.name)).toContain(name);

    // A call stops on a card; the approval row carries the exact arguments.
    const sessionId = await makeSession();
    const ctx = makeTestContext({ sessionId });
    const requestsBefore = server.requests.length;
    const pending = await dispatchTool({ toolCallId: "call-1", name, args: { q: "vex" } }, ctx);
    expect(pending).toMatchObject({ pendingApproval: true, actionKind: "read" });
    expect(server.requests.length).toBe(requestsBefore);
    const enqueued = await enqueueApprovalIntentWithGate(
      {
        sessionId,
        missionId: null,
        missionRunId: null,
        permission: "restricted",
        toolName: name,
        toolArgs: { q: "vex" },
        toolCallId: "call-1",
        result: pending,
        toolContext: ctx,
        intentActionKind: "read",
        origin: "agent",
      },
      async () => ({ kind: "clear" }),
    );
    expect(enqueued.kind).toBe("enqueued");
    if (enqueued.kind !== "enqueued") return;
    const intent = await queryOne<{ preview_json: unknown; action_kind: string }>(
      "SELECT preview_json, action_kind FROM approval_intents WHERE approval_id = $1",
      [enqueued.approvalId],
    );
    expect(intent).toMatchObject({
      action_kind: "read",
      preview_json: { toolName: "Docs / lookup", namespace: "mcp", criticalArgs: { server: "Docs", tool: "lookup", arguments: '{"q":"vex"}' } },
    });
    const queued = await queryOne<{ tool_call: { command: string; args: unknown } }>(
      "SELECT tool_call FROM approval_queue WHERE id = $1",
      [enqueued.approvalId],
    );
    expect(queued?.tool_call).toMatchObject({ command: name, args: { q: "vex" } });

    // The approved resume runs it, with the token, and labels the text untrusted.
    const ran = await dispatchTool({ toolCallId: "call-1", name, args: { q: "vex" } }, { ...ctx, approved: true });
    expect(JSON.parse(ran.output)).toEqual({ server: "Docs", tool: "lookup", untrusted: true, text: 'found: {"q":"vex"}', truncated: false });
    expect(server.requests.at(-1)?.authorization).toBe("Bearer s3cret");

    // Run without asking: only the read-only tool may.
    expect(await setToolAutoRun(write.id, true)).toEqual({ ok: false, reason: "not_read_only" });
    expect(await setToolAutoRun(lookup.id, true)).toEqual({ ok: true });
    expect((await dispatchTool({ toolCallId: "call-2", name, args: { q: "auto" } }, ctx)).success).toBe(true);

    // Locked vault: the token server fails closed.
    locked = true;
    expect((await dispatchTool({ toolCallId: "call-3", name, args: { q: "x" } }, ctx)).output).toMatch(/locked/);
    locked = false;

    // The server changes the schema; a recheck turns the tool off and a resume refuses.
    server.state.lookupSchema = { type: "object", properties: { q: { type: "string" }, lang: { type: "string" } }, required: ["q", "lang"] };
    const recheck = await recheckServer(added.serverId);
    expect(recheck).toMatchObject({ ok: true, changed: ["lookup"] });
    await refreshUserMcpTools();
    expect(getOpenAITools(agentCtx).map((t) => t.function.name)).not.toContain(name);
    expect((await dispatchTool({ toolCallId: "call-1", name, args: { q: "vex" } }, { ...ctx, approved: true })).output).toMatch(/not available/);

    // Remove: the rows go, and (as main does) the vault entry goes first.
    vault.delete(added.serverId);
    expect(await removeServer(added.serverId)).toBe(true);
    expect(await listServersWithTools()).toEqual([]);
    expect(vault.size).toBe(0);
  });
});
