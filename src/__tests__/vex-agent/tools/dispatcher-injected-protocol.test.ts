/**
 * Dispatcher — injected discovered-tool lane (owner decision 2026-08-03,
 * SPEC §7 Q1 / `reports/model-research.md` R1).
 *
 * A discovered manifest is offered to the model as a real function named by its
 * manifest `publicName` (Batch 2; the projection is a catalog TABLE, not a
 * transform of the toolId). This suite pins the four properties that make that
 * safe:
 *
 *  1. the projected name reverse-maps and enters the SAME `executeProtocolTool`
 *     pipeline `execute_tool` uses (arguments ARE the params — no envelope);
 *  2. approval / mutating classification keys off the RESOLVED MANIFEST, never
 *     off the function name;
 *  3. a name this session did not discover (evicted or hallucinated) is
 *     refused by name, pointing at `ToolSearch` select mode;
 *  4. `ToolSearch` records what it returned, and the `execute_tool` envelope is
 *     unchanged.
 *
 * Mocks mirror `execute-tool-taxonomy.test.ts`: `getProtocolManifest` is stubbed
 * so the manifest under test is synthetic and each case is independent of live
 * manifest CONTENT. The toolId/publicName PAIRS below are real catalog pairs on
 * purpose — the name→id reverse map is built from the live catalog at module
 * load and a synthetic name would resolve to nothing, which is exactly the
 * behaviour case 3 pins rather than the routing case 1 pins.
 */

import assert from "node:assert/strict";

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import { makeTestContext } from "./_test-context.js";

vi.mock("@vex-agent/tools/protocols/capture-validator.js", () => ({
  isPreviewExecution: vi.fn(() => false),
  validateCaptureContract: vi.fn(() => true),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return { ...actual, getProtocolManifest: vi.fn(), getProtocolHandler: vi.fn() };
});

vi.mock("@vex-agent/tools/protocols/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/lifecycle.js")>();
  return { ...actual, isExecutableNamespace: vi.fn(() => true) };
});

vi.mock("@vex-agent/tools/protocols/capture-pipeline.js", () => ({
  extractExternalRefs: vi.fn(() => ({})),
  populateCaptureItems: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/executions.js", () => ({
  recordExecution: vi.fn().mockResolvedValue(0),
}));

vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn(),
}));

vi.mock("@vex-agent/db/params.js", () => ({ sanitizeJsonbValue: (v: unknown) => v }));

const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");
const catalog = await import("@vex-agent/tools/protocols/catalog.js");
const { fromInjectedToolName } = await import(
  "@vex-agent/tools/registry/injected-protocol-tools.js"
);
const {
  clearDiscoveredTools,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} = await import("@vex-agent/tools/registry/discovered-tools.js");

const SESSION = "injected-dispatch-session";
const READ_TOOL_ID = "dexscreener.search";
const READ_TOOL_NAME = "dexscreener__pairs_search";
// Mutating case — a real id/name pair that is deliberately NOT prequote-gated,
// so this case isolates the APPROVAL gate rather than the prequote gate. The
// MANIFEST is still synthetic (mutating/actionKind come from the stub).
const MUTATING_TOOL_ID = "pools.claim_fees";
const MUTATING_TOOL_NAME = "pools__fees_claim";

function makeManifest(overrides: Partial<ProtocolToolManifest> = {}): ProtocolToolManifest {
  return {
    toolId: READ_TOOL_ID,
    publicName: READ_TOOL_NAME,
    namespace: "dexscreener",
    lifecycle: "active",
    description: "fake",
    mutating: false,
    actionKind: "read",
    params: [{ key: "query", type: "string", required: true, description: "" }],
    exampleParams: {},
    ...overrides,
  };
}

const context = makeTestContext({ sessionId: SESSION });

beforeEach(() => {
  clearDiscoveredTools(SESSION);
  vi.mocked(catalog.getProtocolManifest).mockReset();
  vi.mocked(catalog.getProtocolHandler).mockReset();
});

describe("dispatcher — injected discovered-tool lane", () => {
  it("routes a mapped name through executeProtocolTool with the call args AS the params", async () => {
    const handler = vi.fn(async (params: Record<string, unknown>) => ({
      success: true,
      output: `ran with ${JSON.stringify(params)}`,
    }));
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);
    recordDiscoveredTools(SESSION, [READ_TOOL_ID]);

    const result = await dispatchTool(
      { name: READ_TOOL_NAME, args: { query: "VEX" }, toolCallId: "call_1" },
      context,
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const [firstHandlerCall] = handler.mock.calls;
    assert.ok(firstHandlerCall);
    expect(firstHandlerCall[0]).toEqual({ query: "VEX" });
    expect(result.actionKind).toBe("read");
  });

  it("enforces the manifest's param boundary — a missing required param is rejected", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(async () => ({
      success: true, output: "should not be called",
    }));
    recordDiscoveredTools(SESSION, [READ_TOOL_ID]);

    const result = await dispatchTool(
      { name: READ_TOOL_NAME, args: {}, toolCallId: "call_2" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Missing required parameter/);
  });

  it("gates approval off the RESOLVED MANIFEST, not the function name", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "should not be called" }));
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({
        toolId: MUTATING_TOOL_ID,
        publicName: MUTATING_TOOL_NAME,
        namespace: "pools",
        mutating: true,
        actionKind: "user_wallet_broadcast",
        params: [],
      }),
    );
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);
    recordDiscoveredTools(SESSION, [MUTATING_TOOL_ID]);

    // restricted + !approved — the mutating gate must fire even though the
    // function name is not registered as a mutating tool anywhere.
    const result = await dispatchTool(
      { name: MUTATING_TOOL_NAME, args: {}, toolCallId: "call_3" },
      context,
    );

    expect(result.pendingApproval).toBe(true);
    expect(result.actionKind).toBe("user_wallet_broadcast");
    expect(handler).not.toHaveBeenCalled();
  });

  it("ToolSearch records the RANKED rows it returned; a namespace listing records nothing", async () => {
    const ranked = await dispatchTool(
      { name: "ToolSearch", args: { query: "token pair search", namespace: "dexscreener" }, toolCallId: "call_d1" },
      context,
    );
    // The model copy carries `publicName`, not the dotted id: the working set is
    // keyed on the id, and the projection strips it before the model sees it.
    const returned = JSON.parse(ranked.output).tools
      .map((t: { publicName: string }) => fromInjectedToolName(t.publicName));
    expect(returned.length).toBeGreaterThan(0);
    expect([...getDiscoveredToolIds(SESSION)]).toEqual(returned);

    clearDiscoveredTools(SESSION);
    await dispatchTool(
      {
        name: "ToolSearch",
        args: { namespace: "dexscreener", list: true },
        toolCallId: "call_d2",
      },
      context,
    );
    // List rows carry no param schema — injecting them would advertise a tool
    // with no parameters, so they are deliberately not recorded.
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("ranked discovery NAMES the ids it displaced from a full session set", async () => {
    // The registry contract is "nothing is silently dropped", and it must hold
    // on BOTH recording paths. Select mode surfaced displacement from the
    // start; the ranked path discarded `recordDiscoveredTools`'s return value,
    // so a tool the model had been told was callable stopped being callable
    // with no signal at all.
    const { MAX_DISCOVERED_TOOLS_PER_SESSION } = await import(
      "@vex-agent/tools/registry/discovered-tools.js"
    );
    const filler = Array.from(
      { length: MAX_DISCOVERED_TOOLS_PER_SESSION },
      (_, i) => `filler.tool${i}`,
    );
    recordDiscoveredTools(SESSION, filler);

    const result = await dispatchTool(
      { name: "ToolSearch", args: { query: "token pair search", namespace: "dexscreener" }, toolCallId: "call_evict" },
      context,
    );
    const payload = JSON.parse(result.output);
    const kept = new Set(getDiscoveredToolIds(SESSION));
    const displaced = filler.filter((id) => !kept.has(id));

    expect(displaced.length).toBeGreaterThan(0);
    const warningText = payload.warnings.join(" ");
    for (const id of displaced) {
      expect(warningText, `ranked discovery evicted ${id} with no signal`).toContain(id);
    }
  });

  it("ranked discovery adds NO displacement warning when it displaced nothing", async () => {
    const result = await dispatchTool(
      { name: "ToolSearch", args: { query: "token pair search", namespace: "dexscreener" }, toolCallId: "call_noevict" },
      context,
    );
    expect(JSON.parse(result.output).warnings.join(" ")).not.toContain("no longer callable");
  });

  it("refuses a name this session never made callable, pointing at ToolSearch select mode", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());

    const result = await dispatchTool(
      { name: READ_TOOL_NAME, args: { query: "VEX" }, toolCallId: "call_4" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain(READ_TOOL_NAME);
    expect(result.output).toContain("ToolSearch");
    // The hint names the CALLABLE name, never the dotted toolId: the id is the
    // durable internal identity and the model has no way to use it — telling it
    // to select an id would be advice that cannot succeed.
    expect(result.output).not.toContain(READ_TOOL_ID);
  });

  it("refuses an injected-shaped name with no manifest at all", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(undefined);

    const result = await dispatchTool(
      { name: "nope__not__real", args: {}, toolCallId: "call_5" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool: nope__not__real");
  });

  it("execute_tool still reaches the same pipeline for an UNDISCOVERED tool", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "ok" }));
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

    const result = await dispatchTool(
      {
        name: "execute_tool",
        args: { toolId: READ_TOOL_ID, params: { query: "VEX" } },
        toolCallId: "call_6",
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });
});
