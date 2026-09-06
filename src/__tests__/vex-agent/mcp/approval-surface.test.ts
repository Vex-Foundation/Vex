/**
 * `approvalSurface` - the launch-form carve-out is surface-scoped.
 *
 * `pools.launch_execute` skips the generic approval
 * card in the desktop app because their own consent FORM is the surface that
 * authorizes the spend. Over the Studio MCP surface that form does not exist,
 * so skipping the card there would let an external agent reach a fund-moving
 * handler with no human consent surface at all.
 *
 * Two properties are pinned here:
 *  1. an OMITTED `approvalSurface` keeps today's in-app carve-out (every direct
 *     `executeProtocolTool` caller in the tree omits it), and
 *  2. `studio_mcp` takes the ordinary approval card and never reaches the
 *     handler.
 *
 * `makeProtocolContext` (the shared builder) constructs the context WITHOUT the
 * field, so this suite is also the typecheck fixture the spec asks for: the
 * field is optional and adding it broke no existing construction site.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { evaluateApprovalGate } from "@vex-agent/tools/protocols/runtime/gates.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { MUTATING_PROTOCOL_ALIAS_ROUTERS } from "@vex-agent/tools/mutating-aliases.js";
import { makeProtocolContext } from "../tools/_test-context.js";

vi.mock("@vex-agent/tools/protocols/capture-validator.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vex-agent/tools/protocols/capture-validator.js")>();
  return { ...actual, isPreviewExecution: vi.fn(() => false) };
});

const LAUNCH_TOOL_IDS = ["pools.launch_execute"] as const;

/** The real manifest, so the gate reads the real `mutating` / `actionKind`. */
function launchManifest(toolId: string): ProtocolToolManifest {
  const manifest = getProtocolManifest(toolId);
  if (!manifest) throw new Error(`missing manifest for ${toolId}`);
  return manifest;
}

describe("launch-tool approval surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(LAUNCH_TOOL_IDS)(
    "%s: an OMITTED surface keeps the in-app launch-form carve-out",
    (toolId) => {
      // The typecheck fixture: no `approvalSurface` key at all.
      const context = makeProtocolContext({ sessionPermission: "restricted", approved: false });
      expect("approvalSurface" in context).toBe(false);

      const pending = evaluateApprovalGate(
        launchManifest(toolId), { toolId }, {}, context,
        undefined, undefined, undefined, undefined, undefined, undefined,
      );
      // No card: the dispatch is allowed through to the handler, which refuses
      // BY NAME and points at the launch form.
      expect(pending).toBeUndefined();
    },
  );

  it.each(LAUNCH_TOOL_IDS)(
    "%s: an EXPLICIT in_app_form surface keeps the carve-out",
    (toolId) => {
      const context = makeProtocolContext({
        sessionPermission: "restricted",
        approved: false,
        approvalSurface: "in_app_form",
      });
      const pending = evaluateApprovalGate(
        launchManifest(toolId), { toolId }, {}, context,
        undefined, undefined, undefined, undefined, undefined, undefined,
      );
      expect(pending).toBeUndefined();
    },
  );

  it.each(LAUNCH_TOOL_IDS)("%s: studio_mcp takes the ordinary approval card", (toolId) => {
    const context = makeProtocolContext({
      sessionPermission: "restricted",
      approved: false,
      approvalSurface: "studio_mcp",
    });
    const pending = evaluateApprovalGate(
      launchManifest(toolId), { toolId }, {}, context,
      undefined, undefined, undefined, undefined, undefined, undefined,
    );
    expect(pending?.pendingApproval).toBe(true);
    expect(pending?.success).toBe(false);
    expect(pending?.output).toContain(toolId);
  });

  it("a FULL-permission project still auto-executes, on either surface", () => {
    for (const toolId of LAUNCH_TOOL_IDS) {
      const pending = evaluateApprovalGate(
        launchManifest(toolId), { toolId }, {},
        makeProtocolContext({ sessionPermission: "full", approvalSurface: "studio_mcp" }),
        undefined, undefined, undefined, undefined, undefined, undefined,
      );
      expect(pending).toBeUndefined();
    }
  });

  /**
   * The MCP surface reaches a launch tool ONLY through the protocol lane, where
   * the surface is stated. The internal mutating aliases dispatch protocol
   * tools too, and they hard-code `in_app_form` - correct today because no
   * alias routes to a carve-out tool. Pinned so a future alias that DID would
   * fail here rather than silently skipping the card for external callers.
   */
  it("no mutating internal alias routes to a launch-form tool", () => {
    const aliasNames = Object.keys(MUTATING_PROTOCOL_ALIAS_ROUTERS);
    expect(aliasNames).toEqual([
      "SwapExecute",
      "SwapExecuteUniswap",
      "BridgeExecute",
      "BridgeExecuteRelay",
    ]);
    for (const name of aliasNames) {
      expect(LAUNCH_TOOL_IDS).not.toContain(name);
    }
  });
});
