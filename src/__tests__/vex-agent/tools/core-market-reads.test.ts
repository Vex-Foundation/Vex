/**
 * T-5 (Kairos Phase 6): the audited core market reads, with the switch ON.
 *
 * What must hold whenever the preload is on:
 *  - every preloaded tool is a read-only, key-free, advertised manifest, and
 *    nothing that can move money is ever admitted without discovery;
 *  - the injected tools array and the dispatcher admit the SAME set (D-DS9-R's
 *    one law), in agent chat and mission run, and neither in mission setup;
 *  - a discovered duplicate of a core read is injected once;
 *  - the Tool Map names the preload, and only while it is on.
 *
 * The OFF path (the shipped value) is every other suite in this folder, which
 * runs against the unmocked switch; `coreMarketReadToolIds(..., false)` is
 * pinned here too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./_dispatcher-test-mocks.js";
import { makeTestContext } from "./_test-context.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

vi.mock("@vex-agent/tools/registry/discovery-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/registry/discovery-policy.js")>();
  return { ...actual, CORE_MARKET_READS_PRELOADED: true, DISCOVERED_TOOL_LRU_CAP: actual.P3_LRU_CAP_WHEN_ON };
});

const mockExecuteProtocolTool = vi.fn<(...args: unknown[]) => Promise<ToolResult>>();
vi.mock("@vex-agent/tools/protocols/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/runtime.js")>();
  return { ...actual, executeProtocolTool: (...args: unknown[]) => mockExecuteProtocolTool(...args) };
});

import {
  CORE_MARKET_READ_TOOL_IDS,
  coreMarketReadToolIds,
  getAdmittedProtocolToolIds,
  isAuditedCoreMarketRead,
} from "@vex-agent/tools/registry/core-market-reads.js";
import {
  clearDiscoveredTools,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { buildInjectedProtocolTools } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { defaultVisibilityContext } from "@vex-agent/tools/registry/visibility.js";
import { getProtocolManifest, PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { buildToolCatalogPrompt } from "@vex-agent/engine/prompts/tool-catalog.js";
import { requireValue } from "../../helpers/require-value.js";

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const SESSION = "t5-core-reads-suite";

const AGENT = { sessionKind: "agent", missionRunActive: false } as const;
const MISSION_RUN = { sessionKind: "mission", missionRunActive: true } as const;
const MISSION_SETUP = { sessionKind: "mission", missionRunActive: false } as const;

function publicNameOf(toolId: string): string {
  return requireValue(getProtocolManifest(toolId)).publicName;
}

const CORE_NAMES = CORE_MARKET_READ_TOOL_IDS.map(publicNameOf);

beforeEach(() => {
  clearDiscoveredTools(SESSION);
  mockExecuteProtocolTool.mockReset();
  mockExecuteProtocolTool.mockResolvedValue({ success: true, output: "{\"rows\":[]}" });
});
afterEach(() => clearDiscoveredTools(SESSION));

describe("T-5 audit", () => {
  it("is exactly the two DexScreener resolver reads, each passing the audit", () => {
    expect(CORE_NAMES).toEqual(["dexscreener__pairs_search", "dexscreener__pair_get"]);
    for (const toolId of CORE_MARKET_READ_TOOL_IDS) {
      const manifest = requireValue(getProtocolManifest(toolId));
      expect(manifest.mutating).toBe(false);
      expect(manifest.actionKind).toBe("read");
      expect(manifest.requiresEnv).toBeUndefined();
      expect(isAuditedCoreMarketRead(manifest)).toBe(true);
    }
  });

  it("the audit refuses every mutating manifest in the catalog", () => {
    const mutating = PROTOCOL_TOOLS.filter((manifest) => manifest.mutating);
    expect(mutating.length).toBeGreaterThan(0);
    expect(mutating.filter(isAuditedCoreMarketRead)).toEqual([]);
  });

  it("OFF preloads nothing in any mode", () => {
    for (const scope of [AGENT, MISSION_RUN, MISSION_SETUP]) {
      expect(coreMarketReadToolIds(scope, false)).toEqual([]);
      expect(getAdmittedProtocolToolIds(SESSION, scope, false)).toEqual(getDiscoveredToolIds(SESSION));
    }
  });
});

describe("T-5 ON: one law, injected equals admitted", () => {
  it("a fresh agent session carries the core reads as real schemas, first", () => {
    const injected = buildInjectedProtocolTools(defaultVisibilityContext({ sessionId: SESSION }));
    expect(injected.map((tool) => tool.function.name)).toEqual(CORE_NAMES);
    for (const tool of injected) expect(tool.function.parameters).toBeDefined();
  });

  it("mission run preloads, mission setup does not", () => {
    const run = defaultVisibilityContext({ sessionId: SESSION, sessionKind: "mission", missionRunActive: true });
    const setup = defaultVisibilityContext({ sessionId: SESSION, sessionKind: "mission", missionRunActive: false });
    expect(buildInjectedProtocolTools(run).map((tool) => tool.function.name)).toEqual(CORE_NAMES);
    expect(buildInjectedProtocolTools(setup)).toEqual([]);
  });

  it("a discovered core read is injected once, and the discovered tail keeps its order", () => {
    recordDiscoveredTools(SESSION, ["kyberswap.swap.quote", "dexscreener.pair.get", "dexscreener.candles"]);
    const names = buildInjectedProtocolTools(defaultVisibilityContext({ sessionId: SESSION }))
      .map((tool) => tool.function.name);
    expect(names).toEqual([...CORE_NAMES, "kyberswap__swap_quote", "dexscreener__candles_list"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the dispatcher admits a core read in a fresh agent session, with no ToolSearch", async () => {
    const result = await dispatchTool(
      { name: "dexscreener__pairs_search", args: { query: "WETH", chain: "ethereum" }, toolCallId: "c1" },
      makeTestContext({ sessionId: SESSION }),
    );
    expect(result.success).toBe(true);
    expect(mockExecuteProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("the dispatcher refuses the same call in mission setup, where it is not injected", async () => {
    const result = await dispatchTool(
      { name: "dexscreener__pairs_search", args: { query: "WETH" }, toolCallId: "c2" },
      makeTestContext({ sessionId: SESSION, sessionKind: "mission", missionId: "m-1" }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool: dexscreener__pairs_search");
    expect(mockExecuteProtocolTool).not.toHaveBeenCalled();
  });

  it("nothing that can move money is admitted without discovery", async () => {
    const mutating = requireValue(
      PROTOCOL_TOOLS.find((manifest) => manifest.mutating && manifest.namespace === "kyberswap"),
    );
    const result = await dispatchTool(
      { name: mutating.publicName, args: {}, toolCallId: "c3" },
      makeTestContext({ sessionId: SESSION, sessionPermission: "full" }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain(`Unknown tool: ${mutating.publicName}`);
    expect(mockExecuteProtocolTool).not.toHaveBeenCalled();
  });

  it("pins the D-DS9-R blocker: the uncallable names the preloaded descriptions print", () => {
    // Why the switch ships OFF (`discovery-policy.ts`): with the preload on, a
    // fresh session's tools array names exactly these protocol tools it cannot
    // call yet. Each is answered by name with a select instruction if called,
    // but lane 1 of `fresh-model-surface-names.test.ts` forbids printing them.
    const admitted = new Set(CORE_NAMES);
    const allNames = PROTOCOL_TOOLS.map((manifest) => manifest.publicName);
    const taught = buildInjectedProtocolTools(defaultVisibilityContext({ sessionId: SESSION }))
      .flatMap((tool) => allNames.filter((name) => tool.function.description.includes(name) && !admitted.has(name)));
    expect([...new Set(taught)].sort()).toEqual(["dexscreener__token_pairs_list", "dexscreener__trades_list"]);
  });

  it("the Tool Map names the preload in agent chat and not in mission setup", () => {
    const agentMap = buildToolCatalogPrompt(defaultVisibilityContext({ sessionId: SESSION }));
    expect(agentMap).toContain("**Preloaded market reads");
    expect(agentMap).toContain(CORE_NAMES.join(", "));
    const setupMap = buildToolCatalogPrompt(
      defaultVisibilityContext({ sessionId: SESSION, sessionKind: "mission", missionRunActive: false }),
    );
    expect(setupMap).not.toContain("Preloaded market reads");
  });
});

describe("P-3 ON pins through the injected lane", () => {
  it("a call that leaves a pending approval pins its tool against displacement", async () => {
    const quote = requireValue(getProtocolManifest("kyberswap.swap.quote"));
    recordDiscoveredTools(SESSION, [quote.toolId]);
    mockExecuteProtocolTool.mockResolvedValueOnce({ success: false, output: "approval", pendingApproval: true });
    await dispatchTool(
      { name: quote.publicName, args: {}, toolCallId: "c4" },
      makeTestContext({ sessionId: SESSION }),
    );
    // 16 fresh tools would displace kyberswap.swap.quote under the LRU cap were
    // it not pinned; the fresh round itself is never displaced either.
    const filler = PROTOCOL_TOOLS
      .filter((manifest) => manifest.toolId !== quote.toolId)
      .slice(0, 16)
      .map((manifest) => manifest.toolId);
    const displaced = recordDiscoveredTools(SESSION, filler);
    expect(displaced).toEqual([]);
    expect(getDiscoveredToolIds(SESSION)).toContain(quote.toolId);
  });
});
