import { describe, it, expect } from "vitest";
import "./_dispatcher-test-mocks.js";
import { makeTestContext } from "./_test-context.js";

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const baseContext = makeTestContext();

describe("dispatcher — protocol meta-tools", () => {
  // ── ToolSearch ────────────────────────────────────────────────────

  it("routes ToolSearch to protocol discovery", async () => {
    const result = await dispatchTool(
      { name: "ToolSearch", args: { query: "bridge tokens across chains", namespace: "khalani" }, toolCallId: "call_1" },
      baseContext,
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.count).toBeGreaterThan(0);
    // The model copy carries the CALLABLE name, never the dotted id.
    expect(parsed.tools[0].publicName).toMatch(/^khalani__/);
    expect(parsed.tools[0]).not.toHaveProperty("toolId");
  });

  it("ToolSearch returns khalani rows as SLIM rows — no param schema", async () => {
    const result = await dispatchTool(
      // Explicit limit (max allowed) so khalani__bridge is in range regardless of ranking.
      { name: "ToolSearch", args: { query: "bridge", namespace: "khalani", limit: 20 }, toolCallId: "call_2" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    const bridge = parsed.tools.find((t: { publicName: string }) => t.publicName === "khalani__bridge_execute");
    expect(bridge).toBeDefined();
    expect(bridge.mutating).toBe(true);
    // The schema travels in the INJECTED function definition, not here.
    expect(bridge).not.toHaveProperty("params");
    expect(bridge.summary.length).toBeGreaterThan(0);
  });

  it("ToolSearch surfaces mutating tools by default — execute-time gate handles approval", async () => {
    // Pre-refactor a discovery-side `includeMutating` filter hid mutating
    // tools by default. That filter was cosmetic — the real safety gate
    // lives at execute time (`runtime.ts`: mutating + !approved + !full
    // loopMode → pendingApproval). Hiding mutating tools at discovery
    // prevented the agent from finding them, so the filter was removed.
    // Mutating tools now appear in ToolSearch results with the `mutating`
    // flag visible per item; agents handle approval at execute time.
    const result = await dispatchTool(
      { name: "ToolSearch", args: { query: "bridge", namespace: "khalani", limit: 20 }, toolCallId: "call_3" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    const hasMutating = parsed.tools.some((t: { mutating: boolean }) => t.mutating);
    expect(hasMutating).toBe(true);
  });

  it("ToolSearch respects query filter", async () => {
    // Explicit limit > DEFAULT_DISCOVERY_LIMIT (5). The test asserts intent
    // ("a tool with 'balance' in id/description exists in the result"), not
    // a specific top-5 ranking. A small limit can drop khalani's balance
    // tool below the cap; bumping to 50 keeps the test robust to ranking shifts.
    const result = await dispatchTool(
      { name: "ToolSearch", args: { query: "balance", limit: 20 }, toolCallId: "call_4" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.count).toBeGreaterThan(0);
    // The model copy has no `toolId` and no full `description`: the slim row's
    // one-line `summary` plus its callable name are what a match is judged on.
    expect(parsed.tools.some((tool: { publicName: string; summary: string }) =>
      tool.publicName.includes("balance") || tool.summary.toLowerCase().includes("balance"),
    )).toBe(true);
  });

  it("ToolSearch respects limit", async () => {
    const result = await dispatchTool(
      { name: "ToolSearch", args: { query: "token", limit: 2 }, toolCallId: "call_5" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.count).toBeLessThanOrEqual(2);
  });

  it("ToolSearch rejects unknown namespaces", async () => {
    const result = await dispatchTool(
      { name: "ToolSearch", args: { namespace: "removed-namespace" }, toolCallId: "call_5b" },
      baseContext,
    );

    expect(result.success).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.warnings[0]).toContain("Unknown namespace");
  });

  // ── execute_tool envelope validation ─────────────────────────────
  //
  // NOT a registered tool any more (`registry/protocol.ts`). These cases
  // exercise the INTERNAL envelope route that cold approval resume depends on,
  // dispatched host-side without `modelOriginated` — which is exactly how
  // `approval-runtime/post-tx/dispatch-approved.ts` re-enters after a restart.

  it("execute_tool fails on missing toolId", async () => {
    const result = await dispatchTool(
      { name: "execute_tool", args: { params: {} }, toolCallId: "call_6" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("toolId");
  });

  it("execute_tool fails on unknown toolId", async () => {
    const result = await dispatchTool(
      { name: "execute_tool", args: { toolId: "fake.tool", params: {} }, toolCallId: "call_7" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown protocol tool");
  });

  it("execute_tool validates required params", async () => {
    const result = await dispatchTool(
      { name: "execute_tool", args: { toolId: "khalani.tokens.search", params: {} }, toolCallId: "call_8" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("query");
  });
});
