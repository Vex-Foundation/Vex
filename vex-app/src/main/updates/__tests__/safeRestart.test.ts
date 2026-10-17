/**
 * safeRestart gate (M13). Blocks on DB-backed agent work OR an in-memory
 * critical op; `prepareForUpdateRestart` flags the restart + tears down the
 * updater event stream (lightweight, per Codex review #2).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasActiveAgentWork = vi.fn();
vi.mock("../../database/mission-runs-db.js", () => ({
  hasActiveAgentWork: () => hasActiveAgentWork(),
}));

const {
  canRestartForUpdate,
  prepareForUpdateRestart,
  isUpdateRestartInProgress,
  __resetSafeRestartForTests,
} = await import("../safeRestart.js");
const { CRITICAL_OP, beginCriticalOp, __resetCriticalOpsForTests } =
  await import("../critical-ops.js");

beforeEach(() => {
  vi.clearAllMocks();
  hasActiveAgentWork.mockResolvedValue({ active: false, reason: "" });
  __resetSafeRestartForTests();
  __resetCriticalOpsForTests();
});

describe("canRestartForUpdate", () => {
  it("allows when idle (no agent work, no critical op)", async () => {
    await expect(canRestartForUpdate()).resolves.toEqual({ ok: true });
  });

  it("blocks on active agent work, surfacing its reason", async () => {
    hasActiveAgentWork.mockResolvedValue({
      active: true,
      reason: "An agent run is still in progress.",
    });
    await expect(canRestartForUpdate()).resolves.toEqual({
      ok: false,
      message: "An agent run is still in progress.",
    });
  });

  it("blocks on an in-flight local runtime op", async () => {
    beginCriticalOp(CRITICAL_OP.localRuntime);
    const result = await canRestartForUpdate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/local database/);
  });

  it("blocks on an in-flight db migration op", async () => {
    beginCriticalOp(CRITICAL_OP.dbMigration);
    const result = await canRestartForUpdate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/migration/i);
  });

  it("blocks on an in-flight secret-vault op (wallet/keystore)", async () => {
    beginCriticalOp(CRITICAL_OP.secretVaultOp);
    const result = await canRestartForUpdate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/wallet|secret/i);
  });
});

describe("prepareForUpdateRestart", () => {
  it("flags the restart in progress (listeners are torn down by quit cleanup, not here)", () => {
    expect(isUpdateRestartInProgress()).toBe(false);
    prepareForUpdateRestart();
    expect(isUpdateRestartInProgress()).toBe(true);
  });
});
