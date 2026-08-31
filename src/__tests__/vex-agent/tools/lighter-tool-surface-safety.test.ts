import { afterEach, describe, expect, it, vi } from "vitest";

import { LIGHTER_TOOLS } from "@vex-agent/tools/protocols/lighter/manifest.js";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import { makeProtocolContext } from "./_test-context.js";

const EXECUTION_TOOLS = [
  "lighter.order.create",
  "lighter.order.cancel",
  "lighter.order.modify",
  "lighter.order.cancelAll",
  "lighter.position.close",
  "lighter.deposit",
  "lighter.withdraw",
  "lighter.withdraw.claim",
  "lighter.key.register",
] as const;

afterEach(() => vi.unstubAllGlobals());

describe("Lighter tool surface safety", () => {
  it.each(LIGHTER_TOOLS)("$toolId rejects approval injected through tool arguments", async (manifest) => {
    const network = vi.fn(() => { throw new Error("Unexpected network access"); });
    vi.stubGlobal("fetch", network);

    const result = await executeProtocolTool({
      toolId: manifest.toolId,
      params: { ...manifest.exampleParams, approved: true },
    }, makeProtocolContext({ sessionId: "lighter-safety-test" }));

    expect(result.success).toBe(false);
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("approved");
    expect(network).not.toHaveBeenCalled();
  });

  for (const sessionPermission of ["restricted", "full"] as const) {
    it.each(EXECUTION_TOOLS)(`%s cannot bypass approval using dryRun in ${sessionPermission} mode`, async (toolId) => {
      const network = vi.fn(() => { throw new Error("Unexpected network access"); });
      vi.stubGlobal("fetch", network);
      const manifest = LIGHTER_TOOLS.find((tool) => tool.toolId === toolId)!;

      const result = await executeProtocolTool({ toolId, params: { ...executionParams(toolId), dryRun: true } },
        makeProtocolContext({ sessionId: "lighter-safety-test", sessionPermission }));

      expect(result.success).toBe(false);
      expect(result.pendingApproval).toBe(true);
      expect(result.output).toMatch(/approv/i);
      expect(result.actionKind).toBe(manifest.actionKind);
      expect(network).not.toHaveBeenCalled();
    });
  }

  it.each(EXECUTION_TOOLS)("%s refuses an approved flag without a host approval identity", async (toolId) => {
    const network = vi.fn(() => { throw new Error("Unexpected network access"); });
    vi.stubGlobal("fetch", network);
    const result = await executeProtocolTool({ toolId, params: executionParams(toolId) },
      makeProtocolContext({ sessionId: "lighter-safety-test", approved: true }));

    expect(result.success).toBe(false);
    expect(result.pendingApproval).toBe(true);
    expect(result.output).toMatch(/approv/i);
    expect(network).not.toHaveBeenCalled();
  });
});

function executionParams(toolId: string): Record<string, unknown> {
  const manifest = LIGHTER_TOOLS.find((tool) => tool.toolId === toolId)!;
  return {
    ...manifest.exampleParams,
    ...(toolId === "lighter.order.cancel" || toolId === "lighter.order.modify"
      || toolId === "lighter.order.cancelAll" || toolId === "lighter.position.close"
      ? { intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001" }
      : {}),
  };
}
