import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../../database/engine-db-readiness.js", () => ({ ensureEngineDbUrl: async () => ({ ok: true }) }));
vi.mock("../../database/migrations-applied.js", () => ({ migrationsApplied: () => true }));

import type { UserMcpNotice, UserMcpRecheckHandle } from "@vex-agent/user-mcp/recheck-executor.js";
import { setupUserMcpRecheckWorker } from "../user-mcp-recheck-worker.js";

const handles: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of handles.splice(0)) await stop();
});

function fakeExecutor() {
  const started: Array<(n: UserMcpNotice) => void> = [];
  const stop = vi.fn(async () => undefined);
  const startExecutor = vi.fn(async (onNotice: (n: UserMcpNotice) => void): Promise<UserMcpRecheckHandle> => {
    started.push(onNotice);
    return { stop, tickNow: async () => undefined };
  });
  return { started, stop, startExecutor };
}

describe("setupUserMcpRecheckWorker", () => {
  it("waits for the database and migrations, then starts the executor once", async () => {
    const exec = fakeExecutor();
    let ready = false;
    const stop = setupUserMcpRecheckWorker({
      ensureDbUrl: async () => ({ ok: ready }),
      migrationsApplied: () => true,
      startExecutor: exec.startExecutor,
      broadcast: vi.fn(),
      intervalMs: 5,
    });
    handles.push(stop);
    await new Promise((r) => setTimeout(r, 30));
    expect(exec.startExecutor).not.toHaveBeenCalled();
    ready = true;
    await vi.waitFor(() => expect(exec.startExecutor).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(exec.startExecutor).toHaveBeenCalledTimes(1);
    await stop();
    expect(exec.stop).toHaveBeenCalledTimes(1);
  });

  it("hands every notice to the broadcaster", async () => {
    const exec = fakeExecutor();
    const broadcast = vi.fn();
    handles.push(setupUserMcpRecheckWorker({ startExecutor: exec.startExecutor, broadcast, intervalMs: 5 }));
    await vi.waitFor(() => expect(exec.started).toHaveLength(1));
    const notice: UserMcpNotice = { serverId: "11111111-2222-4333-8444-555555555555", serverName: "Docs", tools: ["lookup"], reason: "changed" };
    exec.started[0]?.(notice);
    expect(broadcast).toHaveBeenCalledWith(notice);
  });
});
