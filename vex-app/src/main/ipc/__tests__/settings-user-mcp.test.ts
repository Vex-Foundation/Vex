import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";
import type { Result } from "@shared/ipc/result.js";
import type { UserMcpListDto } from "@shared/schemas/user-mcp.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<Result<UserMcpListDto>>;
const handlers = vi.hoisted(() => new Map<string, Handler>());

const SERVER_ID = "11111111-2222-4333-8444-555555555555";
const TOOL_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const state = vi.hoisted(() => ({
  servers: [] as Array<{ server: Record<string, unknown>; tools: Array<Record<string, unknown>> }>,
  calls: [] as string[],
  locked: false,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
}));
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../database/engine-db-readiness.js", () => ({ whenEngineDbReady: async () => undefined }));

vi.mock("@vex-agent/db/repos/user-mcp.js", () => ({
  listServersWithTools: async () => state.servers,
  getServer: async (id: string) => state.servers.find((e) => e.server.id === id)?.server ?? null,
  removeServer: async (id: string) => {
    state.calls.push(`removeServer:${id}`);
    state.servers = state.servers.filter((e) => e.server.id !== id);
    return true;
  },
  setServerHasToken: async (id: string, has: boolean) => {
    state.calls.push(`setHasToken:${has}`);
    return true;
  },
  setToolEnabled: async (_toolId: string, enabled: boolean) =>
    enabled ? { ok: false, reason: "cap_reached" } : { ok: true },
  setToolAutoRun: async () => ({ ok: false, reason: "not_read_only" }),
}));

vi.mock("@vex-agent/user-mcp/store.js", () => ({
  addServer: async (
    input: { name: string; endpoint: string; token: string | null },
    deps: { writeToken: (id: string, token: string) => Promise<void> },
  ) => {
    if (input.endpoint.includes("refuse")) return { ok: false, reason: "unauthorized" };
    if (input.token !== null) await deps.writeToken(SERVER_ID, input.token);
    state.servers.push({
      server: {
        id: SERVER_ID,
        name: input.name,
        endpoint: input.endpoint,
        networkScope: "public",
        hasToken: input.token !== null,
        status: "active",
        failures: 0,
        lastCheckedAt: new Date("2026-10-24T00:00:00Z"),
        lastError: null,
      },
      tools: [
        {
          id: TOOL_ID,
          remoteName: "lookup",
          description: "Look a word up",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          readOnlyHint: true,
          enabled: false,
          autoRun: false,
          status: "active",
          unsupportedReason: null,
        },
      ],
    });
    return { ok: true, serverId: SERVER_ID, tools: 1, unsupported: 0 };
  },
  recheckServer: async () => ({ ok: false, reason: "rate_limited" }),
}));

vi.mock("../../secrets/user-mcp-token.js", () => {
  class UserMcpTokenLockedError extends Error {}
  return {
    UserMcpTokenLockedError,
    writeUserMcpToken: async (id: string, token: string | null) => {
      if (state.locked) throw new UserMcpTokenLockedError();
      state.calls.push(`vault:${id}:${token === null ? "delete" : "write"}`);
    },
    deleteUserMcpToken: async (id: string) => {
      if (state.locked) throw new UserMcpTokenLockedError();
      state.calls.push(`vault:${id}:delete`);
    },
  };
});

import { registerUserMcpSettingsHandlers } from "../settings-user-mcp.js";
import { CH } from "@shared/ipc/channels.js";

const sender = createTrustedSender({ sender: createTestWebContents() });
const invoke = (channel: string, payload: unknown, event: TestIpcEvent = sender): Promise<Result<UserMcpListDto>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler(event, { requestId: "00000000-0000-4000-8000-000000000333", payload });
};

function messageOf(result: Result<UserMcpListDto>): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error.message ?? "";
}

beforeEach(() => {
  handlers.clear();
  state.servers = [];
  state.calls = [];
  state.locked = false;
  registerUserMcpSettingsHandlers();
});

describe("Settings > Tools (MCP) handlers", () => {
  it("adds a server, writes the token to the vault, and never returns the token", async () => {
    const result = await invoke(CH.settings.addUserMcpServer, {
      name: "Docs",
      endpoint: "https://mcp.example.com/mcp",
      token: "s3cret-token-value",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state.calls).toContain(`vault:${SERVER_ID}:write`);
    expect(JSON.stringify(result.data)).not.toContain("s3cret-token-value");
    expect(result.data.servers[0]).toMatchObject({ name: "Docs", hasToken: true, status: "active" });
    expect(result.data.servers[0]!.tools[0]).toMatchObject({ remoteName: "lookup", modelName: "mcp_t3f2504e04f8941d3", enabled: false });
    expect(result.data).toMatchObject({ enabledCount: 0, maxEnabled: 8, maxServers: 5 });
  });

  it("answers a refusal as its code and a sentence, without echoing the input", async () => {
    const result = await invoke(CH.settings.addUserMcpServer, {
      name: "Docs",
      endpoint: "https://refuse.example.com/mcp",
      token: "s3cret-token-value",
    });
    const message = messageOf(result);
    expect(message).toMatch(/^UNAUTHORIZED: The server refused the token/);
    expect(message).not.toContain("s3cret-token-value");
    expect(message).not.toContain("refuse.example.com");
  });

  it("removes the vault token before the server, and refuses while the vault is locked", async () => {
    await invoke(CH.settings.addUserMcpServer, { name: "Docs", endpoint: "https://mcp.example.com/mcp", token: "tok" });
    state.calls = [];
    state.locked = true;
    expect(messageOf(await invoke(CH.settings.removeUserMcpServer, { serverId: SERVER_ID }))).toMatch(/^VAULT_LOCKED/);
    expect(state.calls).toEqual([]);
    state.locked = false;
    const removed = await invoke(CH.settings.removeUserMcpServer, { serverId: SERVER_ID });
    expect(removed.ok).toBe(true);
    expect(state.calls).toEqual([`vault:${SERVER_ID}:delete`, `removeServer:${SERVER_ID}`]);
  });

  it("changes and removes a token, marking the server", async () => {
    await invoke(CH.settings.addUserMcpServer, { name: "Docs", endpoint: "https://mcp.example.com/mcp", token: null });
    state.calls = [];
    expect((await invoke(CH.settings.setUserMcpToken, { serverId: SERVER_ID, token: "new" })).ok).toBe(true);
    expect((await invoke(CH.settings.setUserMcpToken, { serverId: SERVER_ID, token: null })).ok).toBe(true);
    expect(state.calls).toEqual([
      `vault:${SERVER_ID}:write`,
      "setHasToken:true",
      `vault:${SERVER_ID}:delete`,
      "setHasToken:false",
    ]);
  });

  it("names the cap, the read-only rule and the rate limit", async () => {
    expect(messageOf(await invoke(CH.settings.setUserMcpToolEnabled, { toolId: TOOL_ID, enabled: true }))).toMatch(/^CAP_REACHED: Up to 8 tools/);
    expect(messageOf(await invoke(CH.settings.setUserMcpToolAutoRun, { toolId: TOOL_ID, autoRun: true }))).toMatch(/^NOT_READ_ONLY/);
    expect(messageOf(await invoke(CH.settings.recheckUserMcpServer, { serverId: SERVER_ID }))).toMatch(/^RATE_LIMITED/);
  });

  it("refuses unknown fields, a bad id and an untrusted sender", async () => {
    expect((await invoke(CH.settings.setUserMcpToolEnabled, { toolId: TOOL_ID, enabled: true, autoRun: true })).ok).toBe(false);
    expect((await invoke(CH.settings.removeUserMcpServer, { serverId: "not-a-uuid" })).ok).toBe(false);
    const untrusted = { ...sender, senderFrame: { ...sender.senderFrame, url: "https://evil.example" } };
    expect((await invoke(CH.settings.listUserMcp, {}, untrusted)).ok).toBe(false);
  });
});
