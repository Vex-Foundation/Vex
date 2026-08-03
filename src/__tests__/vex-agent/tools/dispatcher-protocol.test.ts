import { describe, it, expect } from "vitest";
import "./_dispatcher-test-mocks.js";
import { makeTestContext } from "./_test-context.js";

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const baseContext = makeTestContext();

describe("dispatcher — protocol meta-tools", () => {
  // ── discover_tools ────────────────────────────────────────────────

  it("routes discover_tools to protocol discovery", async () => {
    const result = await dispatchTool(
      { name: "discover_tools", args: { namespace: "khalani" }, toolCallId: "call_1" },
      baseContext,
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.tools[0].toolId).toMatch(/^khalani\./);
  });

  it("discover_tools returns khalani tools with params", async () => {
    const result = await dispatchTool(
      // Explicit limit (max allowed) so khalani.bridge is in range regardless of ranking.
      { name: "discover_tools", args: { namespace: "khalani", limit: 20 }, toolCallId: "call_2" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    const bridge = parsed.tools.find((t: { toolId: string }) => t.toolId === "khalani.bridge");
    expect(bridge).toBeDefined();
    expect(bridge.mutating).toBe(true);
    expect(bridge.params.length).toBeGreaterThan(0);
  });

  it("discover_tools surfaces mutating tools by default — execute-time gate handles approval", async () => {
    // Pre-refactor a discovery-side `includeMutating` filter hid mutating
    // tools by default. That filter was cosmetic — the real safety gate
    // lives at execute time (`runtime.ts`: mutating + !approved + !full
    // loopMode → pendingApproval). Hiding mutating tools at discovery
    // prevented the agent from finding them, so the filter was removed.
    // Mutating tools now appear in discover_tools with the `mutating`
    // flag visible per item; agents handle approval at execute time.
    const result = await dispatchTool(
      { name: "discover_tools", args: { namespace: "khalani", limit: 20 }, toolCallId: "call_3" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    const hasMutating = parsed.tools.some((t: { mutating: boolean }) => t.mutating);
    expect(hasMutating).toBe(true);
  });

  it("discover_tools respects query filter", async () => {
    // Explicit limit > DEFAULT_DISCOVERY_LIMIT (5). The test asserts intent
    // ("a tool with 'balance' in id/description exists in the result"), not
    // a specific top-5 ranking. A small limit can drop khalani's balance
    // tool below the cap; bumping to 50 keeps the test robust to ranking shifts.
    const result = await dispatchTool(
      { name: "discover_tools", args: { query: "balance", limit: 20 }, toolCallId: "call_4" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.tools.some((tool: { toolId: string; description: string }) =>
      tool.toolId.includes("balance") || tool.description.toLowerCase().includes("balance"),
    )).toBe(true);
  });

  it("discover_tools respects limit", async () => {
    const result = await dispatchTool(
      { name: "discover_tools", args: { limit: 2 }, toolCallId: "call_5" },
      baseContext,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.count).toBeLessThanOrEqual(2);
  });

  it("discover_tools rejects unknown namespaces", async () => {
    const result = await dispatchTool(
      { name: "discover_tools", args: { namespace: "removed-namespace" }, toolCallId: "call_5b" },
      baseContext,
    );

    expect(result.success).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.warnings[0]).toContain("Unknown namespace");
  });

  // ── execute_tool validation ──────────────────────────────────────

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
