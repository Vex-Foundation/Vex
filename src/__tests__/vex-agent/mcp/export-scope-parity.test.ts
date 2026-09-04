/**
 * ONE enumerator: what `tools/list` exports, what `vex_ToolSearch` advertises
 * and what `admitStudioCall` dispatches are the SAME set.
 *
 * `tool-search-export.ts` has always PROMISED this in its published description
 * ("Every tool it returns is in this server's tools/list"), and nothing
 * asserted it - the adapter enumerated through `discoverProtocolCapabilities`
 * and never consulted the export predicate at all. The protocol branch of
 * admission had the mirror-image hole: it resolved a manifest and dispatched it
 * without asking whether the surface exports it, which was harmless only while
 * the predicate meant "is it registered".
 *
 * The exclusion under test is INJECTED rather than taken from the shipped set:
 * `NON_EXPORTED_PROTOCOL_TOOLS` names launchpads locker tools whose manifests do
 * not exist in every tree, and an assertion about a tool that does not exist
 * proves nothing. Widening the predicate over a REAL catalog manifest is what
 * makes these tests fail when the filter is removed. The shipped set itself is
 * checked, by name and against the scope document, in `export-scope.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** A real, active, env-free catalog read tool, withheld only inside this file. */
const WITHHELD_TOOL_ID = "dexscreener.chains";
const WITHHELD_PUBLIC_NAME = "dexscreener__chains_list";

/** The positive control: without it, a filter that hides everything would pass. */
const CONTROL_TOOL_ID = "dexscreener.search";
const CONTROL_PUBLIC_NAME = "dexscreener__pairs_search";

const NAMESPACE = "dexscreener";

const protocolHandler = vi.fn();

vi.mock("@vex-agent/mcp/export-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/mcp/export-scope.js")>();
  const withheld = new Set([WITHHELD_TOOL_ID]);
  return {
    ...actual,
    isExportedProtocolTool: (toolId: string): boolean =>
      !withheld.has(toolId) && actual.isExportedProtocolTool(toolId),
    listExportedTools: (): ReturnType<typeof actual.listExportedTools> =>
      actual.listExportedTools()
        .filter((entry) => entry.kind !== "protocol" || !withheld.has(entry.toolId)),
  };
});

vi.mock("@vex-agent/tools/protocols/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return { ...actual, getProtocolHandler: () => protocolHandler };
});

vi.mock("@vex-agent/tools/protocols/runtime/capture.js", () => ({
  captureExecution: vi.fn().mockResolvedValue(undefined),
}));

const { admitStudioCall } = await import("@vex-agent/mcp/admission.js");
const { searchExportedTools } = await import("@vex-agent/mcp/tool-search-export.js");
const { listExportedTools } = await import("@vex-agent/mcp/export-scope.js");
const { buildProjectToolContext } = await import("@vex-agent/mcp/project-context.js");
const { projectScopeSchema } = await import("@vex-agent/mcp/project-scope.js");
const { getProtocolManifest } = await import("@vex-agent/tools/protocols/catalog.js");
const { discoverProtocolCapabilities } = await import(
  "@vex-agent/tools/protocols/discovery.js"
);

type ProjectScope = import("@vex-agent/mcp/project-scope.js").ProjectScope;

function fullScope(): ProjectScope {
  return projectScopeSchema.parse({
    projectId: "44444444-4444-4444-8444-444444444444",
    scopeVersion: 3,
    permission: "full",
    backingSessionId: "33333333-3333-4333-8333-333333333333",
    wallets: { evm: null, solana: null },
  });
}

function exampleParams(toolId: string): Record<string, unknown> {
  const manifest = getProtocolManifest(toolId);
  if (!manifest) throw new Error(`missing manifest for ${toolId}`);
  return { ...manifest.exampleParams };
}

/** The exported public names, as `tools/list` would publish them. */
function exportedPublicNames(): ReadonlySet<string> {
  return new Set(
    listExportedTools().map((entry) =>
      entry.kind === "protocol" ? entry.publicName : entry.name),
  );
}

/**
 * The UNFILTERED answer for the same request the export adapter makes. Used to
 * prove a negative assertion is not vacuous: the withheld row really was in the
 * candidate answer, and the export dropped it.
 */
async function unfilteredListing(limit?: number) {
  return discoverProtocolCapabilities({
    namespace: NAMESPACE,
    list: true,
    availability: "include-unavailable",
    ...(limit === undefined ? {} : { limit }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  protocolHandler.mockResolvedValue({ success: true, output: "faked handler ran" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the withheld tool really is a candidate", () => {
  it("discovery returns it when nothing filters it", async () => {
    const unfiltered = await unfilteredListing();
    // If this ever fails, the negative assertions below became vacuous - fix
    // the fixture tool, do not delete them.
    expect(unfiltered.tools.map((tool) => tool.toolId)).toContain(WITHHELD_TOOL_ID);
    expect(unfiltered.tools.map((tool) => tool.toolId)).toContain(CONTROL_TOOL_ID);
  });
});

describe("vex_ToolSearch never advertises outside the exported surface", () => {
  it("every row of a namespace listing is in tools/list", async () => {
    const exported = exportedPublicNames();
    const outcome = await searchExportedTools({ namespace: NAMESPACE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.tools.length).toBeGreaterThan(0);
    const outside = outcome.result.tools
      .map((row) => row.publicName)
      .filter((name) => !exported.has(name));
    expect(outside).toEqual([]);
  });

  it("every row of a query answer is in tools/list", async () => {
    const exported = exportedPublicNames();
    const outcome = await searchExportedTools({
      query: "list the supported chains and their dexes",
      limit: 20,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const outside = outcome.result.tools
      .map((row) => row.publicName)
      .filter((name) => !exported.has(name));
    expect(outside).toEqual([]);
  });

  it("drops the withheld row from a listing and names it in warnings", async () => {
    const outcome = await searchExportedTools({ namespace: NAMESPACE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const names = outcome.result.tools.map((row) => row.publicName);
    expect(names).not.toContain(WITHHELD_PUBLIC_NAME);
    // The positive control: the rest of the namespace is untouched.
    expect(names).toContain(CONTROL_PUBLIC_NAME);
    // Not a silent cut: the dropped row is named with its reason.
    expect(outcome.result.warnings.join(" ")).toContain(WITHHELD_PUBLIC_NAME);
    expect(outcome.result.warnings.join(" ")).toContain("not exported");
  });

  it("drops the withheld row from a query that would otherwise return it", async () => {
    const query = "list the supported chains and their dexes";
    const unfiltered = await discoverProtocolCapabilities({
      query,
      limit: 20,
      availability: "include-unavailable",
    });
    // Non-vacuous by construction: assert the candidate answer had it.
    expect(unfiltered.tools.map((tool) => tool.toolId)).toContain(WITHHELD_TOOL_ID);

    const outcome = await searchExportedTools({ query, limit: 20 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.tools.map((row) => row.publicName)).not.toContain(WITHHELD_PUBLIC_NAME);
    expect(outcome.result.warnings.join(" ")).toContain(WITHHELD_PUBLIC_NAME);
  });
});

describe("the counts describe the exported set", () => {
  it("an unbounded listing reports the exported total, not the catalog total", async () => {
    const unfiltered = await unfilteredListing();
    const outcome = await searchExportedTools({ namespace: NAMESPACE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { count, totalCount, hasMore, tools } = outcome.result;
    expect(count).toBe(tools.length);
    // Exactly one row was withheld from a complete listing, so both totals move
    // by exactly one and nothing is left unreachable.
    expect(count).toBe(unfiltered.count - 1);
    expect(totalCount).toBe(unfiltered.totalCount - 1);
    expect(totalCount).toBe(count);
    expect(hasMore).toBe(false);
  });

  it("a bounded listing still discloses that more rows exist", async () => {
    const limit = 3;
    const unfiltered = await unfilteredListing(limit);
    expect(unfiltered.hasMore).toBe(true);

    const outcome = await searchExportedTools({ namespace: NAMESPACE, limit });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { count, totalCount, hasMore, tools } = outcome.result;
    expect(count).toBe(tools.length);
    expect(hasMore).toBe(true);
    expect(totalCount).toBeGreaterThan(count);
    // `totalCount - count` is preserved from discovery, so `hasMore` can never
    // become false while an exported row is still out of the answer.
    expect(totalCount - count).toBe(unfiltered.totalCount - unfiltered.count);
  });
});

describe("admitStudioCall refuses a withheld protocol tool before dispatch", () => {
  it("refuses BY NAME and never reaches the handler", async () => {
    const context = buildProjectToolContext(fullScope());
    const { result, dispatched } = await admitStudioCall(
      {
        name: WITHHELD_PUBLIC_NAME,
        args: exampleParams(WITHHELD_TOOL_ID),
        toolCallId: "call-withheld",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain(WITHHELD_PUBLIC_NAME);
    expect(result.output).toContain("not exported");
    // NOT merely "the result looked like a refusal": the handler is the only
    // thing that can run a protocol tool, and it was never invoked.
    expect(protocolHandler).not.toHaveBeenCalled();
    expect(dispatched).toBe(false);
  });

  it("is not the generic unknown-tool answer", async () => {
    const context = buildProjectToolContext(fullScope());
    const { result } = await admitStudioCall(
      {
        name: WITHHELD_PUBLIC_NAME,
        args: exampleParams(WITHHELD_TOOL_ID),
        toolCallId: "call-withheld-2",
      },
      context,
    );
    expect(result.output).not.toContain("Unknown tool");
  });

  it("the positive control still dispatches", async () => {
    const context = buildProjectToolContext(fullScope());
    const { result, dispatched } = await admitStudioCall(
      {
        name: CONTROL_PUBLIC_NAME,
        args: exampleParams(CONTROL_TOOL_ID),
        toolCallId: "call-control",
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("faked handler ran");
    expect(protocolHandler).toHaveBeenCalledTimes(1);
    expect(dispatched).toBe(true);
    expect(exportedPublicNames().has(CONTROL_PUBLIC_NAME)).toBe(true);
  });
});
