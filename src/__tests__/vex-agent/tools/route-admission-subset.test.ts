/**
 * VISIBLE IMPLIES CALLABLE - the cross-gate test that did not exist (owner
 * decision D-DS9-R, 2026-08-26).
 *
 * TWO GATES, ONE SET. `registry/injected-protocol-tools.ts` decides which
 * protocol schemas enter a request's `tools` array. `dispatcher/protocol-route.ts`
 * decides which protocol names may RUN. Both are supposed to read the same
 * session-scoped discovered set (`registry/discovered-tools.ts`, written only by
 * `ToolSearch`), which makes the visible set a subset of the admitted set. D-DS9
 * widened the first gate to a whole namespace and left the second alone, and
 * nothing failed: no test had ever compared them. The model called the eighteen
 * names it had been handed and every call came back "Unknown tool".
 *
 * So this suite drives the REAL route. It does not compare two sets in the
 * abstract and it does not assert against a reimplementation of the admission
 * rule; it dispatches through `routeToolCall` and reads what the dispatcher
 * actually did, with only the protocol EXECUTION mocked away at the
 * `executeProtocolTool` seam, because what happens after admission is another
 * suite's subject.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import type { ToolResult } from "@vex-agent/tools/types.js";
import { makeTestContext } from "./_test-context.js";

vi.mock("@vex-agent/tools/protocols/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/runtime.js")>();
  return {
    ...actual,
    executeProtocolTool: vi.fn(
      async (call: { toolId: string }): Promise<ToolResult> => ({
        success: true,
        output: `executed ${call.toolId}`,
      }),
    ),
  };
});

const { routeToolCall } = await import("@vex-agent/tools/dispatcher/protocol-route.js");
const runtime = await import("@vex-agent/tools/protocols/runtime.js");
const { PROTOCOL_TOOLS } = await import("@vex-agent/tools/protocols/catalog.js");
const { getOpenAITools } = await import("@vex-agent/tools/registry/openai-tools.js");
const { defaultVisibilityContext } = await import("@vex-agent/tools/registry/visibility.js");
const { isInjectedToolNameShape, fromInjectedToolName } = await import(
  "@vex-agent/tools/registry/injected-protocol-tools.js"
);
const { clearDiscoveredTools, recordDiscoveredTools } = await import(
  "@vex-agent/tools/registry/discovered-tools.js"
);

const SESSION = "route-admission-subset-session";
const context = makeTestContext({ sessionId: SESSION });
const visibility = defaultVisibilityContext({ sessionId: SESSION });

/** A real read-only manifest from the namespace the reverted decision covered. */
const SUBJECT = PROTOCOL_TOOLS.find(
  (manifest) => manifest.namespace === "dexscreener" && !manifest.mutating,
);

beforeEach(() => {
  clearDiscoveredTools(SESSION);
  vi.mocked(runtime.executeProtocolTool).mockClear();
});

describe("route admission and the injected tools array agree", () => {
  it("refuses an injected-shaped name the session never discovered, pointing at ToolSearch", async () => {
    expect(SUBJECT).toBeDefined();
    const name = SUBJECT?.publicName ?? "";

    const result = await routeToolCall({ name, args: {}, toolCallId: "call_undiscovered" }, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain(name);
    expect(result.output).toContain("ToolSearch");
    // Admission refused BEFORE execution: no provider work is done for a name
    // the session was never offered.
    expect(runtime.executeProtocolTool).not.toHaveBeenCalled();
  });

  it("dispatches the SAME name once the discovered set records it", async () => {
    expect(SUBJECT).toBeDefined();
    const toolId = SUBJECT?.toolId ?? "";
    const name = SUBJECT?.publicName ?? "";
    recordDiscoveredTools(SESSION, [toolId]);

    const result = await routeToolCall({ name, args: {}, toolCallId: "call_discovered" }, context);

    expect(result.success).toBe(true);
    expect(runtime.executeProtocolTool).toHaveBeenCalledTimes(1);
    const [firstCall] = vi.mocked(runtime.executeProtocolTool).mock.calls;
    expect(firstCall?.[0]).toEqual({ toolId, params: {} });
  });

  it("every injected-shaped name in this session's tools array is admitted by this session", async () => {
    // A non-trivial working set spanning several namespaces, so the assertion
    // is about the invariant rather than about one lucky row.
    const discovered = [
      ...PROTOCOL_TOOLS.filter((manifest) => manifest.namespace === "dexscreener" && !manifest.mutating)
        .slice(0, 4),
      ...PROTOCOL_TOOLS.filter((manifest) => manifest.namespace === "uniswap").slice(0, 2),
    ];
    expect(discovered.length).toBeGreaterThan(1);
    recordDiscoveredTools(SESSION, discovered.map((manifest) => manifest.toolId));

    const visibleInjected = getOpenAITools(visibility)
      .map((tool) => tool.function.name)
      .filter((name) => isInjectedToolNameShape(name));
    expect(visibleInjected.length).toBeGreaterThan(0);

    for (const name of visibleInjected) {
      const result = await routeToolCall(
        { name, args: {}, toolCallId: `call_${name}` },
        context,
      );
      expect(
        result.success,
        `${name} is in this session's tools array but the dispatcher refused it: ${result.output}`,
      ).toBe(true);
      expect(fromInjectedToolName(name)).toBeDefined();
    }
    expect(runtime.executeProtocolTool).toHaveBeenCalledTimes(visibleInjected.length);
  });
});
