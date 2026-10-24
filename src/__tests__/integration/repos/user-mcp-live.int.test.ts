/**
 * LIVE: the user MCP feature against REAL public infrastructure. Skipped
 * unless `VEX_USER_MCP_LIVE=1` (it needs the internet), like the Lighter live
 * suite.
 *
 *  1. A public https Streamable HTTP MCP server with no token (DeepWiki):
 *     added through the store (real endpoint check, pinned public egress, real
 *     listing), a read tool turned on, offered to the model, and called
 *     through the real dispatcher lane on an approved resume.
 *  2. Egress refusals through real DNS: public names that resolve to a private
 *     or loopback address (nip.io) are refused at connect time, before any
 *     socket exists.
 *
 *   VEX_USER_MCP_LIVE=1 pnpm exec vitest run --config vitest/integration.config.ts \
 *     src/__tests__/integration/repos/user-mcp-live.int.test.ts
 */

import { beforeEach, describe, expect, it } from "vitest";

import { listServersWithTools, setToolEnabled } from "@vex-agent/db/repos/user-mcp.js";
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import { getOpenAITools } from "@vex-agent/tools/registry/openai-tools.js";
import { refreshUserMcpTools } from "@vex-agent/tools/user-mcp/admitted.js";
import { __resetUserMcpCallWindowForTests } from "@vex-agent/tools/user-mcp/route.js";
import { listRemoteTools, UserMcpOperationError } from "@vex-agent/user-mcp/client.js";
import { userMcpToolName } from "@vex-agent/user-mcp/names.js";
import { __resetUserMcpAdminWindowForTests, addServer } from "@vex-agent/user-mcp/store.js";
import { requireValue } from "../../helpers/require-value.js";
import { makeTestContext } from "../../vex-agent/tools/_test-context.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

const LIVE = process.env.VEX_USER_MCP_LIVE === "1";
const PUBLIC_SERVER = process.env.VEX_USER_MCP_LIVE_URL ?? "https://mcp.deepwiki.com/mcp";
const noVault = { writeToken: async () => undefined, deleteToken: async () => undefined };

beforeEach(async () => {
  if (!LIVE) return;
  await resetDb();
  __resetUserMcpAdminWindowForTests();
  __resetUserMcpCallWindowForTests();
});

describe.skipIf(!LIVE)("user MCP, live", () => {
  it("adds a public https MCP server, offers a tool and runs it through the lane", async () => {
    const added = await addServer({ name: "DeepWiki", endpoint: PUBLIC_SERVER, token: null }, noVault);
    expect(added).toMatchObject({ ok: true });
    if (!added.ok) return;
    const entry = requireValue((await listServersWithTools())[0]);
    expect(entry.server).toMatchObject({ networkScope: "public", status: "active", hasToken: false });
    process.stderr.write(`[live] ${PUBLIC_SERVER} listed: ${entry.tools.map((t) => `${t.remoteName}${t.readOnlyHint ? "(ro)" : ""}:${t.status}`).join(", ")}\n`);

    const tool = requireValue(entry.tools.find((t) => t.remoteName === "read_wiki_structure") ?? entry.tools.find((t) => t.status === "active"));
    expect(await setToolEnabled(tool.id, true)).toEqual({ ok: true });
    await refreshUserMcpTools();
    const name = userMcpToolName(tool.id);
    const offered = getOpenAITools({
      permission: "restricted",
      sessionKind: "agent",
      missionRunActive: false,
      planMode: false,
      contextUsageBand: "normal",
      hasSessionMemory: false,
      preparationBypassesBarrier: false,
      hasCompactionSummaryReady: false,
    });
    expect(offered.map((t) => t.function.name)).toContain(name);

    const sessionId = await makeSession();
    const args = tool.remoteName === "read_wiki_structure" ? { repoName: "modelcontextprotocol/typescript-sdk" } : {};
    const pending = await dispatchTool({ name, args, toolCallId: "live-1" }, makeTestContext({ sessionId }));
    expect(pending).toMatchObject({ pendingApproval: true, actionKind: "read" });

    const ran = await dispatchTool({ name, args, toolCallId: "live-1" }, makeTestContext({ sessionId, approved: true }));
    const envelope = JSON.parse(ran.output) as { server: string; tool: string; untrusted: boolean; text: string; truncated: boolean };
    process.stderr.write(`[live] ${tool.remoteName} -> success=${ran.success} chars=${envelope.text.length} truncated=${envelope.truncated} head=${JSON.stringify(envelope.text.slice(0, 160))}\n`);
    expect(ran.success).toBe(true);
    expect(envelope).toMatchObject({ server: "DeepWiki", tool: tool.remoteName, untrusted: true });
    expect(envelope.text.length).toBeGreaterThan(0);
  });

  it("refuses public names that resolve to private or loopback addresses, before any socket", async () => {
    for (const endpoint of ["https://10-0-0-1.nip.io/mcp", "https://127.0.0.1.nip.io/mcp", "https://169.254.169.254.nip.io/mcp"]) {
      const outcome = await addServer({ name: "Rebind", endpoint, token: null }, noVault);
      process.stderr.write(`[live] ${endpoint} -> ${JSON.stringify(outcome)}\n`);
      expect(outcome).toEqual({ ok: false, reason: "blocked_address" });
    }
    let code: string | null = null;
    try {
      await listRemoteTools({ endpoint: "https://10-0-0-1.nip.io/mcp", networkScope: "public", token: null });
    } catch (error) {
      code = error instanceof UserMcpOperationError ? error.code : "other";
    }
    expect(code).toBe("blocked_address");
    expect(await listServersWithTools()).toEqual([]);
  });

  it("refuses a LAN address and plain http to a public host without connecting", async () => {
    expect(await addServer({ name: "LAN", endpoint: "https://192.168.1.1/mcp", token: null }, noVault)).toEqual({ ok: false, reason: "private_address" });
    expect(await addServer({ name: "Plain", endpoint: "http://mcp.deepwiki.com/mcp", token: null }, noVault)).toEqual({ ok: false, reason: "not_https" });
  });
});
