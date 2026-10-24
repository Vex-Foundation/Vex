/**
 * Integration: adding and rechecking a user MCP server end to end, with a
 * REAL `McpServer` over Streamable HTTP on loopback and REAL Postgres.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getServer, listServersWithTools } from "@vex-agent/db/repos/user-mcp.js";
import { __resetUserMcpAdminWindowForTests, addServer, recheckServer } from "@vex-agent/user-mcp/store.js";
import { registerUserMcpTokenReader, type UserMcpTokenRead } from "@vex-agent/user-mcp/token-reader.js";
import { ADMIN_OPS_PER_MINUTE } from "@vex-agent/user-mcp/limits.js";
import { startTestMcpServer, type TestMcpServer } from "../../vex-agent/user-mcp/fixtures/mcp-test-server.js";
import { resetDb } from "../setup/fixtures.js";
import { requireValue } from "../../helpers/require-value.js";

let server: TestMcpServer | null = null;
let unregister: (() => void) | null = null;
const vault = new Map<string, string>();

const deps = {
  writeToken: async (id: string, token: string) => {
    vault.set(id, token);
  },
  deleteToken: async (id: string) => {
    vault.delete(id);
  },
};

function useVaultReader(locked = false): void {
  unregister?.();
  unregister = registerUserMcpTokenReader(async (id): Promise<UserMcpTokenRead> => {
    if (locked) return { kind: "locked" };
    const token = vault.get(id);
    return token === undefined ? { kind: "none" } : { kind: "token", token };
  });
}

beforeEach(async () => {
  await resetDb();
  vault.clear();
  __resetUserMcpAdminWindowForTests();
  useVaultReader();
});

afterEach(async () => {
  await server?.close();
  server = null;
  unregister?.();
  unregister = null;
});

async function only() {
  const [entry] = await listServersWithTools();
  return requireValue(entry);
}

describe("addServer", () => {
  it("lists the tools once and stores them all off", async () => {
    server = await startTestMcpServer();
    const outcome = await addServer({ name: "Docs", endpoint: server.url, token: null }, deps);
    expect(outcome).toMatchObject({ ok: true, tools: 4, unsupported: 0 });
    const entry = await only();
    expect(entry.server).toMatchObject({ name: "Docs", networkScope: "local", hasToken: false, status: "active" });
    expect(entry.tools.map((t) => t.remoteName).sort()).toEqual(["big", "fails", "lookup", "write_note"]);
    expect(entry.tools.every((t) => !t.enabled && !t.autoRun)).toBe(true);
    expect(requireValue(entry.tools.find((t) => t.remoteName === "lookup")).readOnlyHint).toBe(true);
  });

  it("refuses a wrong token and stores nothing; a right one goes to the vault", async () => {
    server = await startTestMcpServer({ token: "right" });
    expect(await addServer({ name: "Docs", endpoint: server.url, token: "wrong" }, deps)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await listServersWithTools()).toEqual([]);
    expect(vault.size).toBe(0);

    const outcome = await addServer({ name: "Docs", endpoint: server.url, token: "right" }, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(vault.get(outcome.serverId)).toBe("right");
    expect((await only()).server.hasToken).toBe(true);
  });

  it("removes the vault entry again when the insert fails", async () => {
    server = await startTestMcpServer({ token: "right" });
    const outcome = await addServer({ name: "Docs", endpoint: server.url, token: "right" }, { ...deps, newId: () => "not-a-uuid" });
    expect(outcome).toEqual({ ok: false, reason: "not_saved" });
    expect(vault.size).toBe(0);
  });

  it("stores a tool whose schema Vex does not accept as unsupported", async () => {
    server = await startTestMcpServer({ state: { lookupSchema: { type: "object", properties: { q: { oneOf: [{ type: "string" }, { type: "number" }] } } } } });
    const outcome = await addServer({ name: "Docs", endpoint: server.url, token: null }, deps);
    expect(outcome).toMatchObject({ ok: true, unsupported: 1 });
    expect((await only()).tools.find((t) => t.remoteName === "lookup")).toMatchObject({ status: "unsupported" });
  });

  it("refuses a duplicate endpoint and a private address before any request", async () => {
    server = await startTestMcpServer();
    await addServer({ name: "Docs", endpoint: server.url, token: null }, deps);
    const before = server.requests.length;
    expect(await addServer({ name: "Again", endpoint: server.url, token: null }, deps)).toEqual({ ok: false, reason: "already_added" });
    expect(await addServer({ name: "LAN", endpoint: "https://192.168.1.20/mcp", token: null }, deps)).toEqual({ ok: false, reason: "private_address" });
    expect(server.requests.length).toBe(before);
  });
});

describe("recheckServer", () => {
  it("turns a tool off when the server changes its schema", async () => {
    server = await startTestMcpServer();
    const added = await addServer({ name: "Docs", endpoint: server.url, token: null }, deps);
    if (!added.ok) throw new Error("add failed");
    server.state.lookupSchema = { type: "object", properties: { q: { type: "string" }, lang: { type: "string" } }, required: ["q"] };
    const outcome = await recheckServer(added.serverId);
    expect(outcome).toMatchObject({ ok: true, changed: ["lookup"] });
    expect((await only()).tools.find((t) => t.remoteName === "lookup")).toMatchObject({ status: "drifted", enabled: false });
  });

  it("skips a token server while the vault is locked, without counting a failure", async () => {
    server = await startTestMcpServer({ token: "right" });
    const added = await addServer({ name: "Docs", endpoint: server.url, token: "right" }, deps);
    if (!added.ok) throw new Error("add failed");
    const requests = server.requests.length;
    useVaultReader(true);
    expect(await recheckServer(added.serverId)).toEqual({ ok: false, reason: "vault_locked" });
    expect(server.requests.length).toBe(requests);
    expect(requireValue(await getServer(added.serverId)).failures).toBe(0);
    useVaultReader(false);
    expect((await recheckServer(added.serverId)).ok).toBe(true);
  });

  it("moves a server that stops answering to error on the third failure", async () => {
    server = await startTestMcpServer();
    const added = await addServer({ name: "Docs", endpoint: server.url, token: null }, deps);
    if (!added.ok) throw new Error("add failed");
    await server.close();
    server = null;
    const fast = { client: { timeoutMs: 3_000 } };
    expect(await recheckServer(added.serverId, fast)).toMatchObject({ ok: false, reason: "unreachable", movedToError: false });
    expect(await recheckServer(added.serverId, fast)).toMatchObject({ ok: false, movedToError: false });
    expect(await recheckServer(added.serverId, fast)).toMatchObject({ ok: false, movedToError: true });
    expect(requireValue(await getServer(added.serverId)).status).toBe("error");
  });

  it(`limits Settings to ${ADMIN_OPS_PER_MINUTE} adds and checks a minute`, async () => {
    server = await startTestMcpServer();
    const added = await addServer({ name: "Docs", endpoint: server.url, token: null }, deps);
    if (!added.ok) throw new Error("add failed");
    for (let i = 1; i < ADMIN_OPS_PER_MINUTE; i++) {
      expect((await recheckServer(added.serverId, { fromSettings: true })).ok).toBe(true);
    }
    expect(await recheckServer(added.serverId, { fromSettings: true })).toEqual({ ok: false, reason: "rate_limited" });
    // The worker is not charged.
    expect((await recheckServer(added.serverId)).ok).toBe(true);
  });
});
