/**
 * Studio MCP admission and executor - every in-app gate still fires, and the
 * only thing the surface skips is the session working set.
 *
 * The handler is faked (`getProtocolHandler`) so a dispatch that IS allowed can
 * be observed without touching a provider; every GATE is the real one. Capture
 * is stubbed because a successful mutation would otherwise write the audit row
 * to a database this unit suite does not have.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const protocolHandler = vi.fn();

vi.mock("@vex-agent/tools/protocols/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return { ...actual, getProtocolHandler: () => protocolHandler };
});

vi.mock("@vex-agent/tools/protocols/runtime/capture.js", () => ({
  captureExecution: vi.fn().mockResolvedValue(undefined),
}));

const { admitStudioCall } = await import("@vex-agent/mcp/admission.js");
const { executeStudioTool } = await import("@vex-agent/mcp/executor.js");
const { buildProjectToolContext } = await import("@vex-agent/mcp/project-context.js");
const { projectScopeSchema } = await import("@vex-agent/mcp/project-scope.js");
const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");
const { getProtocolManifest } = await import("@vex-agent/tools/protocols/catalog.js");
const { getDiscoveredToolIds } = await import("@vex-agent/tools/registry/discovered-tools.js");

type ProjectScope = import("@vex-agent/mcp/project-scope.js").ProjectScope;

const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function scope(permission: "restricted" | "full" = "restricted"): ProjectScope {
  return projectScopeSchema.parse({
    projectId: "44444444-4444-4444-8444-444444444444",
    scopeVersion: 3,
    permission,
    backingSessionId: SESSION_ID,
    wallets: { evm: null, solana: null },
  });
}

function call(name: string, args: Record<string, unknown> = {}) {
  return { name, args, toolCallId: `call-${name}` };
}

/** The manifest's own authored worked call - always valid against its schema. */
function exampleParams(toolId: string): Record<string, unknown> {
  const manifest = getProtocolManifest(toolId);
  if (!manifest) throw new Error(`missing manifest for ${toolId}`);
  return { ...manifest.exampleParams };
}

const JUPITER_KEY = "JUPITER_API_KEY";
const originalJupiterKey = process.env[JUPITER_KEY];

beforeEach(() => {
  vi.clearAllMocks();
  protocolHandler.mockResolvedValue({ success: true, output: "faked handler ran" });
  delete process.env[JUPITER_KEY];
});

afterEach(() => {
  if (originalJupiterKey === undefined) delete process.env[JUPITER_KEY];
  else process.env[JUPITER_KEY] = originalJupiterKey;
});

describe("gate parity - approval", () => {
  it("a mutating PROTOCOL tool under a restricted project returns the pending refusal", async () => {
    const context = buildProjectToolContext(scope("restricted"));
    const { result, dispatched } = await admitStudioCall(
      call("pools__launch_execute", exampleParams("pools.launch_execute")),
      context,
    );

    expect(result.pendingApproval).toBe(true);
    expect(result.success).toBe(false);
    expect(result.output).toContain("pools.launch_execute");
    // The whole result is retained, including the taxonomy stamp A3's approval
    // preview binds on.
    expect(result.actionKind).toBe("user_wallet_broadcast");
    // The handler was NEVER reached: this surface has no launch form, so the
    // in-app carve-out must not apply.
    expect(protocolHandler).not.toHaveBeenCalled();
    expect(dispatched).toBe(true);
  });

  it("a mutating INTERNAL tool under a restricted project returns the pending refusal", async () => {
    const context = buildProjectToolContext(scope("restricted"));
    const { result } = await admitStudioCall(
      call("WalletSendConfirm", { intentId: "not-reached" }),
      context,
    );
    expect(result.pendingApproval).toBe(true);
    expect(result.output).toContain("requires approval");
  });

  it("a FULL-permission project dispatches to the handler", async () => {
    const context = buildProjectToolContext(scope("full"));
    const { result, dispatched } = await admitStudioCall(
      call("pools__launch_execute", exampleParams("pools.launch_execute")),
      context,
    );
    expect(protocolHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.output).toBe("faked handler ran");
    expect(dispatched).toBe(true);
  });

  it("the studio_mcp surface reaches the protocol handler with the project context", async () => {
    const context = buildProjectToolContext(scope("full"));
    await admitStudioCall(
      call("dexscreener__pairs_search", exampleParams("dexscreener.search")),
      context,
    );
    const passed = protocolHandler.mock.calls[0]?.[1] as {
      approvalSurface?: string;
      sessionId?: string;
      approved?: boolean;
    };
    expect(passed?.approvalSurface).toBe("studio_mcp");
    expect(passed?.sessionId).toBe(SESSION_ID);
    expect(passed?.approved).toBe(false);
  });
});

describe("direct unsearched protocol execution", () => {
  it("runs without any working set, and records none", async () => {
    expect(getDiscoveredToolIds(SESSION_ID)).toEqual([]);

    const context = buildProjectToolContext(scope("full"));
    const { result } = await admitStudioCall(
      call("dexscreener__pairs_search", exampleParams("dexscreener.search")),
      context,
    );

    expect(result.success).toBe(true);
    expect(protocolHandler).toHaveBeenCalledTimes(1);
    expect(getDiscoveredToolIds(SESSION_ID)).toEqual([]);
  });

  it("the IN-APP guard is unchanged: dispatchTool still refuses the same call", async () => {
    const context = buildProjectToolContext(scope("full"));
    const result = await dispatchTool(
      { name: "dexscreener__pairs_search", args: exampleParams("dexscreener.search"), toolCallId: "t" },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool: dexscreener__pairs_search");
    expect(result.output).toContain("ToolSearch");
  });
});

describe("name resolution and refusals", () => {
  it("resolves a retired internal name to its live tool", async () => {
    const context = buildProjectToolContext(scope("restricted"));
    // `wallet_send_confirm` is the retired spelling of `WalletSendConfirm`.
    const { result } = await admitStudioCall(call("wallet_send_confirm", {}), context);
    expect(result.pendingApproval).toBe(true);
    expect(result.output).toContain("WalletSendConfirm");
  });

  it("answers an unknown name with the search hint", async () => {
    const context = buildProjectToolContext(scope("full"));
    const { result, dispatched } = await admitStudioCall(call("nope__not_a_tool"), context);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool: nope__not_a_tool");
    expect(result.output).toContain("vex_ToolSearch");
    expect(dispatched).toBe(false);
  });

  it.each(["execute_tool", "MemorySearch", "SessionMemorySearch", "PlanWrite", "CompactApply"])(
    "refuses %s as not exported, without dispatching",
    async (name) => {
      const context = buildProjectToolContext(scope("full"));
      const { result, dispatched } = await admitStudioCall(call(name), context);
      expect(result.success).toBe(false);
      expect(result.output).toContain("not exported");
      expect(dispatched).toBe(false);
      expect(protocolHandler).not.toHaveBeenCalled();
    },
  );

  it("dispatchTool with the BUILT context refuses execute_tool as model-originated", async () => {
    // Proves `modelOriginated: true` is really built, not merely pre-filtered
    // by admission.
    const context = buildProjectToolContext(scope("full"));
    const result = await dispatchTool(
      { name: "execute_tool", args: { toolId: "dexscreener.search" }, toolCallId: "t" },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("execute_tool is not callable");
    expect(protocolHandler).not.toHaveBeenCalled();
  });
});

describe("configuration availability", () => {
  it("a protocol tool with an unmet requiresEnv answers the typed result", async () => {
    const context = buildProjectToolContext(scope("full"));
    const { result, dispatched } = await admitStudioCall(
      call("solana__swap_quote", exampleParams("solana.swap.quote")),
      context,
    );
    expect(result.failure).toEqual({ kind: "configuration_unavailable", env: [JUPITER_KEY] });
    expect(result.output).toContain(JUPITER_KEY);
    expect(result.success).toBe(false);
    expect(dispatched).toBe(false);
    expect(protocolHandler).not.toHaveBeenCalled();
  });

  it("a provider with NO declared key never yields configuration_unavailable", async () => {
    const context = buildProjectToolContext(scope("full"));
    const { result } = await admitStudioCall(
      call("relay__bridge_quote_get", exampleParams("relay.quote.get")),
      context,
    );
    expect(result.failure).toBeUndefined();
  });

  it("a DYNAMIC internal alias yields the same typed outcome from the runtime", async () => {
    // `SwapQuote` declares no `requiresEnv`; on Solana it routes to the Jupiter
    // manifest that does. The pre-dispatch hint layer cannot see that, so the
    // structured field on the runtime's refusal is what carries the cause.
    const context = buildProjectToolContext(scope("full"));
    const { result } = await admitStudioCall(
      call("SwapQuote", {
        chain: "solana",
        tokenIn: "So11111111111111111111111111111111111111112",
        tokenOut: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountIn: "1",
      }),
      context,
    );
    expect(result.failure).toEqual({ kind: "configuration_unavailable", env: [JUPITER_KEY] });
    expect(result.output).toContain(JUPITER_KEY);
  });

  it("the same tool runs once the key is configured", async () => {
    process.env[JUPITER_KEY] = "test-key";
    const context = buildProjectToolContext(scope("full"));
    const { result } = await admitStudioCall(
      call("solana__swap_quote", exampleParams("solana.swap.quote")),
      context,
    );
    expect(result.failure).toBeUndefined();
    expect(protocolHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe("executeStudioTool", () => {
  it("returns the whole result, the call id, and a measured duration", async () => {
    const execution = await executeStudioTool(
      scope("full"),
      call("dexscreener__pairs_search", exampleParams("dexscreener.search")),
    );
    expect(execution.toolCallId).toBe("call-dexscreener__pairs_search");
    expect(execution.result.output).toBe("faked handler ran");
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("omits durationMs for a synthetic refusal that never dispatched", async () => {
    const execution = await executeStudioTool(scope("full"), call("MemorySearch"));
    expect(execution.durationMs).toBeUndefined();
    expect(execution.result.success).toBe(false);
  });

  it("keeps a pending approval result whole for the approval runtime", async () => {
    const execution = await executeStudioTool(
      scope("restricted"),
      call("pools__launch_execute", exampleParams("pools.launch_execute")),
    );
    expect(execution.result.pendingApproval).toBe(true);
    expect(execution.result.actionKind).toBe("user_wallet_broadcast");
  });

  it("threads the caller's abort signal into the tool context", async () => {
    const controller = new AbortController();
    await executeStudioTool(
      scope("full"),
      call("dexscreener__pairs_search", exampleParams("dexscreener.search")),
      controller.signal,
    );
    const passed = protocolHandler.mock.calls[0]?.[1] as { abortSignal?: AbortSignal };
    expect(passed?.abortSignal).toBe(controller.signal);
  });
});
