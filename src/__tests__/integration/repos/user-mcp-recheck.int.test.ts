/**
 * Integration: the user MCP recheck worker against a REAL `McpServer` and
 * REAL Postgres. A schema change turns the tool off and raises one `changed`
 * notice; a server that stops answering raises `not_answering` on the third
 * failure; a token server is skipped while the vault is locked; every tick
 * reloads the offered-tools snapshot.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execute } from "@vex-agent/db/client.js";
import { listServersWithTools, setToolEnabled } from "@vex-agent/db/repos/user-mcp.js";
import { getAdmittedUserMcpTools, refreshUserMcpTools } from "@vex-agent/tools/user-mcp/admitted.js";
import { startUserMcpRecheckExecutor, type UserMcpNotice } from "@vex-agent/user-mcp/recheck-executor.js";
import { __resetUserMcpAdminWindowForTests, addServer } from "@vex-agent/user-mcp/store.js";
import { registerUserMcpTokenReader, type UserMcpTokenRead } from "@vex-agent/user-mcp/token-reader.js";
import { startTestMcpServer, type TestMcpServer } from "../../vex-agent/user-mcp/fixtures/mcp-test-server.js";
import { resetDb } from "../setup/fixtures.js";

let server: TestMcpServer | null;
let unregister: () => void;
let locked = false;
const vault = new Map<string, string>();
const deps = { writeToken: async (id: string, t: string) => void vault.set(id, t), deleteToken: async (id: string) => void vault.delete(id) };

beforeEach(async () => {
  await resetDb();
  vault.clear();
  locked = false;
  __resetUserMcpAdminWindowForTests();
  unregister = registerUserMcpTokenReader(async (id): Promise<UserMcpTokenRead> => {
    if (locked) return { kind: "locked" };
    const token = vault.get(id);
    return token === undefined ? { kind: "none" } : { kind: "token", token };
  });
});

afterEach(async () => {
  unregister();
  await server?.close();
  server = null;
  await refreshUserMcpTools();
});

async function makeDue(): Promise<void> {
  await execute("UPDATE user_mcp_servers SET last_checked_at = now() - interval '7 hours'");
}

describe("the recheck worker", () => {
  it("loads the snapshot, turns a changed tool off and raises one notice", async () => {
    server = await startTestMcpServer();
    const added = await addServer({ name: "Docs", endpoint: server.url, token: null }, deps);
    if (!added.ok) throw new Error("add failed");
    const lookup = (await listServersWithTools())[0]!.tools.find((t) => t.remoteName === "lookup")!;
    await setToolEnabled(lookup.id, true);

    const notices: UserMcpNotice[] = [];
    const worker = startUserMcpRecheckExecutor({ onNotice: (n) => notices.push(n), tickMs: 60_000 });
    await worker.tickNow();
    expect(getAdmittedUserMcpTools().map((t) => t.remoteName)).toEqual(["lookup"]);

    server.state.lookupSchema = { type: "object", properties: { word: { type: "string" } }, required: ["word"] };
    await makeDue();
    await worker.tickNow();
    await worker.stop();
    expect(notices).toEqual([{ serverId: added.serverId, serverName: "Docs", tools: ["lookup"], reason: "changed" }]);
    expect(getAdmittedUserMcpTools()).toEqual([]);
  });

  it("raises not_answering on the third failed check, and skips a token server while locked", async () => {
    server = await startTestMcpServer({ token: "tok" });
    const added = await addServer({ name: "Docs", endpoint: server.url, token: "tok" }, deps);
    if (!added.ok) throw new Error("add failed");
    const notices: UserMcpNotice[] = [];
    const worker = startUserMcpRecheckExecutor({ onNotice: (n) => notices.push(n), tickMs: 60_000 });
    await worker.tickNow();

    locked = true;
    const requests = server.requests.length;
    for (let i = 0; i < 4; i++) {
      await makeDue();
      await worker.tickNow();
    }
    expect(server.requests.length).toBe(requests);
    expect(notices).toEqual([]);
    locked = false;

    await server.close();
    server = null;
    for (let i = 0; i < 3; i++) {
      await makeDue();
      await worker.tickNow();
    }
    await worker.stop();
    expect(notices).toEqual([{ serverId: added.serverId, serverName: "Docs", tools: [], reason: "not_answering" }]);
    expect((await listServersWithTools())[0]!.server.status).toBe("error");
  });
});
