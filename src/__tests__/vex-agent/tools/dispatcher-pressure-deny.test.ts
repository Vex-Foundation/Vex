/**
 * Dispatcher hard-deny + protocol runtime pressure guard — codex P2 #3 (round 3)
 * required gates that lacked direct coverage.
 *
 * The cutover exposes TWO independent pressure barriers at runtime:
 *   1. `checkPressureDeny` in `tools/dispatcher.ts` — synthetic error for any
 *      `mutating` call that bypassed the catalog projection.
 *   2. Inline guard in `tools/protocols/runtime.ts:executeProtocolTool` — same
 *      shape for the protocol meta-tool namespace (`discover_tools` /
 *      `execute_tool` → `executeProtocolTool`).
 *
 * Both must reject at barrier+ with a clear hint pointing the agent at
 * `CompactApply`. The catalog-level filter (already covered in
 * `tools/registry.test.ts`) is the soft signal; these are the runtime guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeProtocolContext } from "./_test-context.js";

// ── Top-level vi.mocks (hoisted) ──────────────────────────────────
// Mock identifiers must be declared at module scope BEFORE `vi.mock` calls
// reach them after hoist. Putting them inside `describe` triggers a TDZ.

const mockGetManifest = vi.fn();
const mockGetHandler = vi.fn();

vi.mock("../../../vex-agent/tools/protocols/catalog.js", () => ({
  getProtocolManifest: (...a: unknown[]) => mockGetManifest(...a),
  getProtocolHandler: (...a: unknown[]) => mockGetHandler(...a),
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

vi.mock("../../../vex-agent/tools/protocols/capture-validator.js", () => ({
  isPreviewExecution: vi.fn().mockReturnValue(false),
  validateCaptureContract: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../vex-agent/tools/protocols/capture-pipeline.js", () => ({
  extractExternalRefs: vi.fn().mockReturnValue([]),
  populateCaptureItems: vi.fn(),
}));

vi.mock("../../../vex-agent/tools/protocols/lifecycle.js", () => ({
  isExecutableNamespace: vi.fn().mockReturnValue(true),
  NAMESPACE_LIFECYCLE: {},
}));

vi.mock("../../../vex-agent/tools/protocols/mutation-matrix.js", () => ({
  MUTATION_MATRIX: new Map(),
}));

vi.mock("../../../vex-agent/db/repos/executions.js", () => ({
  recordExecution: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../../vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn(),
}));

import { checkPressureDeny } from "../../../vex-agent/tools/dispatcher.js";
import { executeProtocolTool } from "../../../vex-agent/tools/protocols/runtime.js";
import type { ContextUsageBand } from "../../../vex-agent/engine/core/context-band.js";

describe("checkPressureDeny — runtime hard-deny (dispatcher)", () => {
  it("returns null for unknown tool names (routing layer produces the error)", () => {
    expect(checkPressureDeny("nonexistent_tool", "barrier")).toBeNull();
    expect(checkPressureDeny("nonexistent_tool", "critical")).toBeNull();
    expect(checkPressureDeny("nonexistent_tool", "normal")).toBeNull();
  });

  it("blocks mutating tools at barrier band, naming no tool the agent must call", () => {
    const result = checkPressureDeny("WalletSendConfirm", "barrier");
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.output).toContain("blocked");
    expect(result!.output).toContain("barrier");
    // The copy is agent-visible. Under v2 the runtime compacts on its own, so
    // instructing a tool call here would produce a hallucinated one every turn.
    expect(result!.output).not.toMatch(/compact_now/);
    expect(result!.output).toContain("automatically");
  });

  it("BYPASS: a live preparation un-blocks mutating tools at barrier", () => {
    expect(checkPressureDeny("WalletSendConfirm", "barrier", true)).toBeNull();
  });

  it("BYPASS does NOT extend to critical — forced apply owns that band", () => {
    const result = checkPressureDeny("WalletSendConfirm", "critical", true);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });

  it("the bypass parameter DEFAULTS to false — omitting it keeps today's barrier", () => {
    // Every pre-existing call site relies on this. A default of `true` would
    // silently remove the barrier process-wide.
    expect(checkPressureDeny("WalletSendConfirm", "barrier")).not.toBeNull();
  });

  it("blocks mutating tools at critical band", () => {
    const result = checkPressureDeny("WalletSendConfirm", "critical");
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.output).toContain("critical");
  });

  it("does NOT block mutating tools at normal band", () => {
    expect(checkPressureDeny("WalletSendConfirm", "normal")).toBeNull();
  });

  it("does NOT block mutating tools at warning band (the LLM still sees them)", () => {
    expect(checkPressureDeny("WalletSendConfirm", "warning")).toBeNull();
  });

  it("CompactApply is safe_at_barrier — never pressure-denied at any band", () => {
    // It is the pressure RELIEF; gating it on pressure would be circular, and
    // a prepared summary is worth applying the moment it exists.
    for (const band of ["normal", "warning", "barrier", "critical"] as const) {
      expect(checkPressureDeny("CompactApply", band), `CompactApply @ ${band}`).toBeNull();
    }
  });

  it("ALLOWS read_only tools at every band", () => {
    const bands: ContextUsageBand[] = ["normal", "warning", "barrier", "critical"];
    for (const band of bands) {
      expect(checkPressureDeny("SessionMemorySearch", band), `SessionMemorySearch @ ${band}`).toBeNull();
      expect(checkPressureDeny("MemorySearch", band), `MemorySearch @ ${band}`).toBeNull();
      expect(checkPressureDeny("WalletBalances", band), `WalletBalances @ ${band}`).toBeNull();
    }
  });
});

describe("executeProtocolTool — pressure guard (protocol runtime)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeManifest(toolId: string, mutating: boolean) {
    return {
      namespace: "test_ns",
      toolId,
      mutating,
      lifecycle: "active" as const,
      params: [],
    };
  }

  it("blocks a mutating protocol tool at barrier band", async () => {
    mockGetManifest.mockReturnValue(makeManifest("test.mutate", true));
    mockGetHandler.mockReturnValue(vi.fn());

    const result = await executeProtocolTool(
      { toolId: "test.mutate", params: {} },
      makeProtocolContext({
        sessionPermission: "full",
        approved: false,
        sessionId: "s-1",
        contextUsageBand: "barrier",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("blocked");
    expect(result.output).toContain("barrier");
    expect(result.output).not.toMatch(/compact_now/);
    // Handler must NOT have been called.
    expect(mockGetHandler).not.toHaveBeenCalled();
  });

  it("blocks a mutating protocol tool at critical band", async () => {
    mockGetManifest.mockReturnValue(makeManifest("test.mutate", true));
    mockGetHandler.mockReturnValue(vi.fn());

    const result = await executeProtocolTool(
      { toolId: "test.mutate", params: {} },
      makeProtocolContext({
        sessionPermission: "full",
        approved: false,
        sessionId: "s-1",
        contextUsageBand: "critical",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("critical");
  });

  it("ALLOWS a non-mutating protocol tool at barrier", async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: "ok" });
    mockGetManifest.mockReturnValue(makeManifest("test.read", false));
    mockGetHandler.mockReturnValue(handler);

    const result = await executeProtocolTool(
      { toolId: "test.read", params: {} },
      makeProtocolContext({
        sessionPermission: "full",
        approved: false,
        sessionId: "s-1",
        contextUsageBand: "barrier",
      }),
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it("ALLOWS a mutating protocol tool at normal band", async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: "ok" });
    mockGetManifest.mockReturnValue(makeManifest("test.mutate", true));
    mockGetHandler.mockReturnValue(handler);

    const result = await executeProtocolTool(
      { toolId: "test.mutate", params: {} },
      makeProtocolContext({
        sessionPermission: "full",
        approved: true,
        sessionId: "s-1",
        contextUsageBand: "normal",
      }),
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it("ALLOWS a mutating protocol tool at warning band (only barrier+ blocks)", async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: "ok" });
    mockGetManifest.mockReturnValue(makeManifest("test.mutate", true));
    mockGetHandler.mockReturnValue(handler);

    const result = await executeProtocolTool(
      { toolId: "test.mutate", params: {} },
      makeProtocolContext({
        sessionPermission: "full",
        approved: true,
        sessionId: "s-1",
        contextUsageBand: "warning",
      }),
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalled();
  });
});
