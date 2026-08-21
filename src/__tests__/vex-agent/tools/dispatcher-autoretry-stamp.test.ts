/**
 * Phase 4d — dispatcher auto-retry safety stamp.
 *
 * The stamp marks a mission run auto-retry-UNSAFE BEFORE any mutating tool
 * runs, so an error after a side effect can never auto-retry. Verifies:
 *   - the mutating-target predicate (internal flag + execute_tool target manifest),
 *   - the stamp fires for a mutating dispatch with a mission run,
 *   - it is skipped for read-only tools and non-mission dispatches,
 *   - FAIL-CLOSED: if the stamp write throws, the mutating handler never runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolCallRequest } from "@vex-agent/tools/types.js";
import { makeTestContext } from "./_test-context.js";

const markAutoRetryUnsafe = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  markAutoRetryUnsafe: (...a: unknown[]) => markAutoRetryUnsafe(...a),
}));

const getProtocolManifest = vi.fn();
vi.mock("../../../vex-agent/tools/protocols/catalog.js", async (importActual) => {
  // Preserve every real export (PROTOCOL_TOOLS, getProtocolHandler, …) — the
  // protocol scoring modules read them at import time — and override only the
  // manifest lookup so the stamp predicate is controllable.
  const actual = await importActual<
    typeof import("../../../vex-agent/tools/protocols/catalog.js")
  >();
  return { ...actual, getProtocolManifest: (...a: unknown[]) => getProtocolManifest(...a) };
});

const handleWalletSendConfirm = vi
  .fn()
  .mockResolvedValue({ success: true, output: "confirmed" });
vi.mock("../../../vex-agent/tools/internal/wallet/send.js", () => ({
  handleWalletSendConfirm: (...a: unknown[]) => handleWalletSendConfirm(...a),
  handleWalletSendPrepare: vi
    .fn()
    .mockResolvedValue({ success: true, output: "prepared" }),
}));

const handleWalletBalances = vi
  .fn()
  .mockResolvedValue({ success: true, output: "read" });
vi.mock("../../../vex-agent/tools/internal/wallet/read.js", () => ({
  handleWalletBalances: (...a: unknown[]) => handleWalletBalances(...a),
}));

const executeProtocolTool = vi
  .fn()
  .mockResolvedValue({ success: true, output: "executed" });
vi.mock("../../../vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool: (...a: unknown[]) => executeProtocolTool(...a),
  discoverProtocolCapabilities: vi.fn().mockResolvedValue({ success: true, tools: [] }),
}));

const { dispatchTool, dispatchTargetIsMutating } = await import(
  "../../../vex-agent/tools/dispatcher.js"
);

function ctx(missionRunId: string | null): InternalToolContext {
  return makeTestContext({
    sessionId: "s1",
    sessionPermission: "full",
    missionRunId,
    missionId: "m1",
    sessionKind: "mission",
  });
}

/** `toolCallId` is required on `ToolCallRequest`; the stamp never reads it. */
function call(name: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return { name, args, toolCallId: `call-${name}` };
}

beforeEach(() => {
  markAutoRetryUnsafe.mockResolvedValue(undefined);
  getProtocolManifest.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("dispatchTargetIsMutating", () => {
  it("internal mutating tool → true; read-only → false", () => {
    expect(dispatchTargetIsMutating(call("WalletSendConfirm"))).toBe(true);
    expect(dispatchTargetIsMutating(call("WalletBalances"))).toBe(false);
    expect(dispatchTargetIsMutating(call("AgentScan"))).toBe(false);
    // The execute_tool WRAPPER itself is mutating:false — never stamp on the name.
    expect(dispatchTargetIsMutating(call("execute_tool"))).toBe(false);
  });

  it("execute_tool stamps based on the TARGET manifest", () => {
    getProtocolManifest.mockReturnValue({ mutating: true });
    expect(
      dispatchTargetIsMutating(call("execute_tool", { toolId: "user_wallet_broadcast" })),
    ).toBe(true);
    expect(getProtocolManifest).toHaveBeenCalledWith("user_wallet_broadcast");

    getProtocolManifest.mockReturnValue({ mutating: false });
    expect(
      dispatchTargetIsMutating(call("execute_tool", { toolId: "external_post" })),
    ).toBe(false);

    // Unknown / missing target → not mutating (no stamp).
    getProtocolManifest.mockReturnValue(undefined);
    expect(
      dispatchTargetIsMutating(call("execute_tool", { toolId: "ghost" })),
    ).toBe(false);
    expect(dispatchTargetIsMutating(call("execute_tool"))).toBe(false);
  });
});

describe("stamp on dispatch", () => {
  it("stamps before a mutating tool runs (mission run present)", async () => {
    await dispatchTool(call("WalletSendConfirm", { intentId: "i1" }), ctx("run-1"));
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1");
    expect(handleWalletSendConfirm).toHaveBeenCalledTimes(1);
  });

  it("does NOT stamp a read-only tool", async () => {
    await dispatchTool(call("WalletBalances"), ctx("run-1"));
    expect(markAutoRetryUnsafe).not.toHaveBeenCalled();
    expect(handleWalletBalances).toHaveBeenCalledTimes(1);
  });

  it("does NOT stamp when there is no mission run (missionRunId null)", async () => {
    await dispatchTool(call("WalletSendConfirm", { intentId: "i1" }), ctx(null));
    expect(markAutoRetryUnsafe).not.toHaveBeenCalled();
    expect(handleWalletSendConfirm).toHaveBeenCalledTimes(1);
  });

  it("FAIL-CLOSED: a stamp write failure prevents the mutating handler from running", async () => {
    markAutoRetryUnsafe.mockRejectedValueOnce(new Error("db down"));
    const result = await dispatchTool(
      call("WalletSendConfirm", { intentId: "i1" }),
      ctx("run-1"),
    );
    expect(result.success).toBe(false);
    expect(handleWalletSendConfirm).not.toHaveBeenCalled();
  });
});

describe("stamp on execute_tool (protocol target)", () => {
  it("mutating target user_wallet_broadcast → stamps before executeProtocolTool", async () => {
    getProtocolManifest.mockReturnValue({ mutating: true });
    await dispatchTool(
      call("execute_tool", { toolId: "user_wallet_broadcast", params: {} }),
      ctx("run-1"),
    );
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1");
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("mutating target external_post → stamps before executeProtocolTool", async () => {
    getProtocolManifest.mockReturnValue({ mutating: true });
    await dispatchTool(
      call("execute_tool", { toolId: "external_post", params: {} }),
      ctx("run-1"),
    );
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1");
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("read-only protocol target → no stamp, still executes", async () => {
    getProtocolManifest.mockReturnValue({ mutating: false });
    await dispatchTool(
      call("execute_tool", { toolId: "dexscreener.token_lookup", params: {} }),
      ctx("run-1"),
    );
    expect(markAutoRetryUnsafe).not.toHaveBeenCalled();
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("FAIL-CLOSED: stamp failure on a mutating execute_tool blocks protocol execution", async () => {
    getProtocolManifest.mockReturnValue({ mutating: true });
    markAutoRetryUnsafe.mockRejectedValueOnce(new Error("db down"));
    const result = await dispatchTool(
      call("execute_tool", { toolId: "user_wallet_broadcast", params: {} }),
      ctx("run-1"),
    );
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});
