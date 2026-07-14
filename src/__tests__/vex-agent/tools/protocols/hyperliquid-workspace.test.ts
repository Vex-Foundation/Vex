import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hyperliquidWorkspaceRequestBus } from "@vex-agent/engine/events/hyperliquid-workspace-bus.js";
import { registerHlWorkspaceModeProvider, clearHlWorkspaceModeProvider } from "../../../../lib/hyperliquid-workspace-mode.js";
import { HYPERLIQUID_HANDLERS } from "@vex-agent/tools/protocols/hyperliquid/handlers.js";
import { HYPERLIQUID_TOOLS } from "@vex-agent/tools/protocols/hyperliquid/manifest.js";
import { INTERNAL_TOOL_LOADERS } from "@vex-agent/tools/dispatcher/internal-loaders.js";

beforeEach(() => {
  clearHlWorkspaceModeProvider();
});

afterEach(() => {
  clearHlWorkspaceModeProvider();
});

describe("Hyperliquid workspace tools", () => {
  it.each([
    ["hyperliquid.workspace.enter", "hypervexing"],
    ["hyperliquid.workspace.exit", "normal"],
  ] as const)("%s emits a typed engine request", async (toolId, mode) => {
    if (mode === "normal") registerHlWorkspaceModeProvider(() => "hypervexing");
    const listener = vi.fn();
    const off = hyperliquidWorkspaceRequestBus.subscribe(listener);
    try {
      const handler = HYPERLIQUID_HANDLERS[toolId];
      if (handler === undefined) throw new Error(`Missing handler for ${toolId}`);
      const result = await handler({}, { sessionId: "00000000-0000-4000-8000-000000000001" } as never);
      expect(listener).toHaveBeenCalledWith({
        sessionId: "00000000-0000-4000-8000-000000000001",
        mode,
        requestedBy: "agent",
      });
      expect(result).toMatchObject({
        success: true,
        data: {
          _displayBlock: {
            namespace: "hyperliquid",
            kind: "workspace_mode_request",
            mode,
            requestedBy: "agent",
          },
        },
      });
    } finally {
      off();
    }
  });

  it("classifies both workspace requests as non-mutating local writes", () => {
    const manifests = HYPERLIQUID_TOOLS.filter((tool) => tool.toolId.startsWith("hyperliquid.workspace."));
    expect(manifests).toHaveLength(2);
    expect(manifests.every((tool) => !tool.mutating && tool.actionKind === "local_write")).toBe(true);
  });

  it("returns an already-active typed display block without emitting a duplicate enter request", async () => {
    registerHlWorkspaceModeProvider(() => "hypervexing");
    const listener = vi.fn();
    const off = hyperliquidWorkspaceRequestBus.subscribe(listener);
    try {
      const handler = HYPERLIQUID_HANDLERS["hyperliquid.workspace.enter"];
      if (handler === undefined) throw new Error("Missing Hyperliquid workspace-enter handler.");
      const result = await handler({}, { sessionId: "00000000-0000-4000-8000-000000000001" } as never);
      expect(listener).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        data: {
          alreadyActive: true,
          _displayBlock: {
            kind: "workspace_mode_request",
            alreadyActive: true,
          },
        },
      });
    } finally {
      off();
      clearHlWorkspaceModeProvider();
    }
  });

  it("routes hyperliquid_enter through the shared idempotent request path", async () => {
    registerHlWorkspaceModeProvider(() => "normal");
    const listener = vi.fn();
    const off = hyperliquidWorkspaceRequestBus.subscribe(listener);
    try {
      const load = INTERNAL_TOOL_LOADERS.hyperliquid_enter;
      if (load === undefined) throw new Error("Missing hyperliquid_enter internal loader.");
      const handler = await load();
      const result = await handler({}, { sessionId: "00000000-0000-4000-8000-000000000001" } as never);
      expect(listener).toHaveBeenCalledWith({
        sessionId: "00000000-0000-4000-8000-000000000001",
        mode: "hypervexing",
        requestedBy: "agent",
      });
      expect(result).toMatchObject({
        success: true,
        data: { alreadyActive: false },
      });
    } finally {
      off();
      clearHlWorkspaceModeProvider();
    }
  });

});
