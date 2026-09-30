/**
 * P-2 (Kairos Phase 6) switched ON: a `ToolSearch` query records, and so
 * injects, only its top `P2_INJECT_TOP_N_WHEN_ON` ranked rows. The rest are
 * still shown and are tagged `notLoaded`, and the next-step sentence says how
 * to make one callable.
 *
 * The OFF path (the shipped value) is the whole existing `tool-search.test.ts`
 * suite plus the explicit "records every ranked row" case below, run in a
 * sibling file that does not mock the switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./_dispatcher-test-mocks.js";
import { makeTestContext } from "./_test-context.js";

vi.mock("@vex-agent/tools/registry/discovery-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/registry/discovery-policy.js")>();
  return { ...actual, TOOLSEARCH_INJECT_TOP_N: actual.P2_INJECT_TOP_N_WHEN_ON };
});

import { P2_INJECT_TOP_N_WHEN_ON } from "@vex-agent/tools/registry/discovery-policy.js";
import {
  clearDiscoveredTools,
  getDiscoveredToolIds,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { buildInjectedProtocolTools } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { defaultVisibilityContext } from "@vex-agent/tools/registry/visibility.js";
import { DEFAULT_DISCOVERY_LIMIT } from "@vex-agent/tools/protocols/discovery.js";

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const SESSION = "p2-top-n-suite";

interface Row {
  readonly publicName: string;
  readonly notLoaded?: boolean;
}

async function search(args: Record<string, unknown>): Promise<{ nextStep: string; tools: Row[] }> {
  const result = await dispatchTool(
    { name: "ToolSearch", args, toolCallId: `call-${String(Math.random())}` },
    makeTestContext({ sessionId: SESSION }),
  );
  return JSON.parse(result.output) as { nextStep: string; tools: Row[] };
}

beforeEach(() => clearDiscoveredTools(SESSION));
afterEach(() => clearDiscoveredTools(SESSION));

describe("P-2 ON: ToolSearch injects only the top N ranked schemas", () => {
  it("shows the default five rows but records only the top N", async () => {
    const parsed = await search({ query: "swap quote on base" });
    expect(parsed.tools).toHaveLength(DEFAULT_DISCOVERY_LIMIT);
    const topNames = parsed.tools.slice(0, P2_INJECT_TOP_N_WHEN_ON).map((row) => row.publicName);

    const injected = buildInjectedProtocolTools(defaultVisibilityContext({ sessionId: SESSION }))
      .map((tool) => tool.function.name);
    expect(injected).toEqual(topNames);
    expect(getDiscoveredToolIds(SESSION)).toHaveLength(P2_INJECT_TOP_N_WHEN_ON);
  });

  it("tags every shown-but-not-recorded row, and only those", async () => {
    const parsed = await search({ query: "swap quote on base" });
    expect(parsed.tools.map((row) => row.notLoaded === true)).toEqual([
      false, false, true, true, true,
    ]);
  });

  it("tells the model the first N are callable next message and how to load the rest", async () => {
    const parsed = await search({ query: "swap quote on base" });
    expect(parsed.nextStep).toContain(`The first ${String(P2_INJECT_TOP_N_WHEN_ON)} rows are now in your tool list`);
    expect(parsed.nextStep).toContain("NEXT message");
    expect(parsed.nextStep).toContain("select:<publicName>");
  });

  it("a query with N or fewer rows is answered exactly as before (no tag, old next step)", async () => {
    const parsed = await search({ query: "swap quote on base", limit: P2_INJECT_TOP_N_WHEN_ON });
    expect(parsed.tools.some((row) => row.notLoaded === true)).toBe(false);
    expect(parsed.nextStep).toContain("Each row below is now in your tool list");
  });

  it("select still records every name it accepts (select is the explicit order)", async () => {
    const parsed = await search({ query: "swap quote on base" });
    const names = parsed.tools.map((row) => row.publicName);
    await search({ query: `select:${names.join(",")}` });
    expect(getDiscoveredToolIds(SESSION)).toHaveLength(names.length);
  });
});
