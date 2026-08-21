/**
 * FIXTURE-ALIAS EQUIVALENCE, the safety contract for the deprecation-alias
 * mechanism (approved plan section 5.5).
 *
 * The production alias table is empty in Batch 1, so it cannot prove anything
 * about a rename. This suite registers TEST-ONLY fixture aliases through the
 * seam in `registry/name-resolution.ts` and asserts that calling a tool by its
 * retired name is INDISTINGUISHABLE from calling it by its canonical name at
 * every name-bearing boundary:
 *
 *   (i)   pressure-band hard deny (the `barrier` and `critical` bands);
 *   (ii)  plan-mode acceptance (blocked mutating target, allowed read target);
 *   (iii) approval enqueue: the DURABLE `approval_queue.tool_call` and the
 *         manifest fingerprint bind to the CANONICAL identity;
 *   (iv)  approval preview: the human sees the canonical identity;
 *   (v)   cold approval resume: a row stored under the OLD name before the
 *         rename still dispatches to the canonical manifest in a later process;
 *   (vi)  direct dispatch: identical ToolResult.
 *
 * Fixtures span both identity spaces and both grammars, deliberately:
 *
 *   - a READ target and a MUTATING target, because the gates branch on exactly
 *     that distinction and an alias resolving only on the read path would be a
 *     money-path hole;
 *   - an INTERNAL name (whose name IS its identity) and PROTOCOL names (whose
 *     identity is the immutable dotted toolId);
 *   - a retired name in TODAY's mechanical grammar (every dot became a double
 *     underscore) and one in the TARGET grammar (exactly one double underscore,
 *     at the namespace boundary). The target-grammar fixture is the one that
 *     catches a resolver which recovers a toolId by INVERTING the name:
 *     `kyberswap__swap_getquote` inverts to `kyberswap.swap_getquote`, not
 *     the immutable `kyberswap.swap.quote`.
 *
 * The catalog is stubbed (same shape as `dispatcher-injected-protocol.test.ts`)
 * so the manifests under test are synthetic and independent of live catalog
 * state. This suite is about NAME RESOLUTION, not about any real tool.
 */

import assert from "node:assert/strict";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { DeprecatedToolAlias } from "@vex-agent/tools/registry/name-resolution.js";
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

// The MUTATING fixture reaches the capture pipeline, which lazily imports the
// full execution-intent trio (`protocols/runtime/capture.ts`). Stubbing only
// `recordExecution` would fail capture and turn a successful dispatch into a
// failed ToolResult, which would hide the property under test.
vi.mock("@vex-agent/db/repos/executions.js", () => ({
  createExecutionIntent: vi.fn().mockResolvedValue(1),
  completeExecutionIntentWith: vi.fn().mockResolvedValue(undefined),
  recordExecution: vi.fn().mockResolvedValue(1),
  getById: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn(),
}));

vi.mock("@vex-agent/db/params.js", () => ({ sanitizeJsonbValue: (v: unknown) => v }));

const mockGetActivePlan = vi.fn();
vi.mock("@vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: (...a: unknown[]) => mockGetActivePlan(...a),
}));

const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");
const catalog = await import("@vex-agent/tools/protocols/catalog.js");
const { clearDiscoveredTools, recordDiscoveredTools } = await import(
  "@vex-agent/tools/registry/discovered-tools.js"
);
const { registerToolNameAliasesForTest, resetToolNameAliasesForTest } = await import(
  "@vex-agent/tools/registry/name-resolution.js"
);
const { buildApprovalToolCall, computeManifestFingerprint } = await import(
  "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js"
);
const { buildIntentPreview } = await import("@vex-agent/engine/core/approval-intent-preview.js");
const { resolveInjectedProtocolTool } = await import(
  "@vex-agent/tools/registry/injected-protocol-tools.js"
);

const SESSION = "alias-equivalence-session";

// ── Fixtures ──────────────────────────────────────────────────────
// A READ target and a MUTATING target, each with a retired spelling that exists
// only for this suite.
const READ_TOOL_ID = "dexscreener.search";
const READ_CANONICAL = "dexscreener__pairs_search";
const READ_DEPRECATED = "legacy_fixture_search";

// A REAL (toolId, publicName) pair, not a synthetic one: the name-to-id reverse
// map is built once from the LIVE catalog, so a made-up publicName can never
// resolve and the catalog-selection, envelope and preview assertions below
// would all pass vacuously. `morpho.rewards.claim` is chosen because it is
// mutating (the gates branch on exactly that) yet carries NO prequote-registry
// entry, so dispatching it in this suite exercises the alias path rather than a
// bridge/swap prequote gate that has nothing to do with name resolution.
const MUTATING_TOOL_ID = "morpho.rewards.claim";
const MUTATING_CANONICAL = "morpho__rewards_claim";
const MUTATING_DEPRECATED = "legacy_fixture_mutate";

// An INTERNAL tool (not a protocol manifest) whose registry `pressureSafety` is
// `mutating`. The pressure gate reads the registry, not the catalog, so the
// pressure case needs a real registered name.
const PRESSURE_CANONICAL = "SwapExecute";
const PRESSURE_DEPRECATED = "legacy_fixture_swap_execute";

// TARGET-GRAMMAR fixture: exactly one double underscore, at the namespace
// boundary. Inverting this name yields `kyberswap.SwapQuote`, which is NOT the
// immutable toolId, so any resolver that recovers the id by string inversion
// fails here and only here.
const GRAMMAR_TOOL_ID = "kyberswap.swap.quote";
const GRAMMAR_DEPRECATED = "kyberswap__swap_getquote";
/** What a mechanical inverse mapping would wrongly produce. */
const GRAMMAR_WRONG_INVERSION = "kyberswap.swap_getquote";

const FIXTURE_ALIASES: readonly DeprecatedToolAlias[] = [
  {
    deprecatedName: READ_DEPRECATED,
    canonicalId: READ_TOOL_ID,
    kind: "protocol",
    since: "0.0.0-test",
    removeAfter: "retired name absent from the injected tools array",
    reason: "fixture",
  },
  {
    deprecatedName: MUTATING_DEPRECATED,
    canonicalId: MUTATING_TOOL_ID,
    kind: "protocol",
    since: "0.0.0-test",
    removeAfter: "retired name absent from the injected tools array",
    reason: "fixture",
  },
  {
    deprecatedName: GRAMMAR_DEPRECATED,
    canonicalId: GRAMMAR_TOOL_ID,
    kind: "protocol",
    since: "0.0.0-test",
    removeAfter: "retired name absent from the injected tools array",
    reason: "fixture for the target one-boundary grammar",
  },
  {
    deprecatedName: PRESSURE_DEPRECATED,
    canonicalId: PRESSURE_CANONICAL,
    kind: "internal",
    since: "0.0.0-test",
    removeAfter: "no unresolved approval_queue row and no enabled plan names it",
    reason: "fixture",
  },
];

function grammarManifest(): ProtocolToolManifest {
  return {
    toolId: GRAMMAR_TOOL_ID,
    publicName: "kyberswap__swap_quote",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "fixture target-grammar tool",
    mutating: false,
    actionKind: "read",
    params: [{ key: "chain", type: "string", required: true, description: "" }],
    exampleParams: {},
  };
}

function readManifest(): ProtocolToolManifest {
  return {
    toolId: READ_TOOL_ID,
    publicName: "dexscreener__pairs_search",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "fixture read tool",
    mutating: false,
    actionKind: "read",
    params: [{ key: "query", type: "string", required: true, description: "" }],
    exampleParams: {},
  };
}

function mutatingManifest(): ProtocolToolManifest {
  return {
    toolId: MUTATING_TOOL_ID,
    publicName: "morpho__rewards_claim",
    namespace: "morpho",
    lifecycle: "active",
    description: "fixture mutating tool",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "amount", type: "string", required: true, description: "" },
      { key: "to", type: "string", required: true, description: "" },
    ],
    exampleParams: {},
  };
}

/** Serve whichever synthetic manifest the dotted id asks for. */
function stubCatalog(): void {
  vi.mocked(catalog.getProtocolManifest).mockImplementation((toolId: string) => {
    if (toolId === READ_TOOL_ID) return readManifest();
    if (toolId === MUTATING_TOOL_ID) return mutatingManifest();
    if (toolId === GRAMMAR_TOOL_ID) return grammarManifest();
    // Deliberately unknown: what a wrong string inversion would ask for.
    return undefined;
  });
}

/**
 * Two dispatches of the same tool must agree on everything the caller acts on.
 * `durationMs` is the one field that legitimately differs (it is wall clock),
 * so it is compared for PRESENCE rather than value; dropping it entirely would
 * let a stamped/unstamped difference between the two lanes pass unnoticed.
 */
function expectSameResult(actual: ToolResult, expected: ToolResult): void {
  const { durationMs: actualMs, ...actualRest } = actual;
  const { durationMs: expectedMs, ...expectedRest } = expected;
  expect(actualRest).toEqual(expectedRest);
  expect(actualMs === undefined).toBe(expectedMs === undefined);
}

let disposeAliases: (() => void) | null = null;

beforeEach(() => {
  clearDiscoveredTools(SESSION);
  vi.mocked(catalog.getProtocolManifest).mockReset();
  vi.mocked(catalog.getProtocolHandler).mockReset();
  mockGetActivePlan.mockReset();
  stubCatalog();
  disposeAliases = registerToolNameAliasesForTest(FIXTURE_ALIASES);
});

afterEach(() => {
  disposeAliases?.();
  disposeAliases = null;
  resetToolNameAliasesForTest();
});

// ── (vi) direct dispatch ──────────────────────────────────────────

describe("alias equivalence: direct dispatch", () => {
  it("dispatches the deprecated name to the canonical manifest with identical result", async () => {
    const handler = vi.fn(async (params: Record<string, unknown>) => ({
      success: true,
      output: `ran with ${JSON.stringify(params)}`,
    }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);
    recordDiscoveredTools(SESSION, [READ_TOOL_ID]);
    const context = makeTestContext({ sessionId: SESSION });

    const viaCanonical = await dispatchTool(
      { name: READ_CANONICAL, args: { query: "VEX" }, toolCallId: "c1" },
      context,
    );
    const viaAlias = await dispatchTool(
      { name: READ_DEPRECATED, args: { query: "VEX" }, toolCallId: "c2" },
      context,
    );

    expect(viaAlias.success).toBe(viaCanonical.success);
    expect(viaAlias.output).toBe(viaCanonical.output);
    expect(viaAlias.actionKind).toBe(viaCanonical.actionKind);
    expect(viaAlias.actionKind).toBe("read");
    expect(handler).toHaveBeenCalledTimes(2);
    const [, secondCall] = handler.mock.calls;
    assert.ok(secondCall);
    expect(secondCall[0]).toEqual({ query: "VEX" });
  });

  it("still refuses a name that is neither canonical nor a registered alias", async () => {
    recordDiscoveredTools(SESSION, [READ_TOOL_ID]);
    const result = await dispatchTool(
      { name: "not_an_alias_at_all", args: {}, toolCallId: "c3" },
      makeTestContext({ sessionId: SESSION }),
    );
    // The existing unknown-tool handling stays authoritative and still answers
    // with the name the model actually wrote.
    expect(result.success).toBe(false);
    expect(result.output).toBe("Unknown tool: not_an_alias_at_all");
  });
});

// ── (i) pressure gating ───────────────────────────────────────────

describe("alias equivalence: pressure-band hard deny", () => {
  for (const band of ["barrier", "critical"] as const) {
    it(`denies the deprecated name exactly as the canonical name at ${band}`, async () => {
      const context = makeTestContext({ sessionId: SESSION, contextUsageBand: band });

      const viaCanonical = await dispatchTool(
        { name: PRESSURE_CANONICAL, args: {}, toolCallId: "p1" },
        context,
      );
      const viaAlias = await dispatchTool(
        { name: PRESSURE_DEPRECATED, args: {}, toolCallId: "p2" },
        context,
      );

      expect(viaCanonical.success).toBe(false);
      expect(viaCanonical.output).toMatch(/blocked at context pressure/);
      // Identical, INCLUDING the message: the deny names the canonical tool,
      // never the retired spelling.
      expectSameResult(viaAlias, viaCanonical);
      expect(viaAlias.output).toContain(PRESSURE_CANONICAL);
      expect(viaAlias.output).not.toContain(PRESSURE_DEPRECATED);
    });
  }

  it("does not deny the deprecated name of a read tool at barrier", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "ok" }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);
    recordDiscoveredTools(SESSION, [READ_TOOL_ID]);

    const result = await dispatchTool(
      { name: READ_DEPRECATED, args: { query: "VEX" }, toolCallId: "p3" },
      makeTestContext({ sessionId: SESSION, contextUsageBand: "barrier" }),
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ── (ii) plan-mode acceptance ─────────────────────────────────────

describe("alias equivalence: plan-mode acceptance gate", () => {
  const ACTIVE_UNACCEPTED = {
    sessionId: SESSION,
    enabled: true,
    planMd: "# plan",
    acceptedAt: null,
    accepted: false,
    offNoticePending: false,
    createdAt: "t",
    updatedAt: "t",
  };

  it("blocks the deprecated name of a MUTATING target exactly as the canonical name", async () => {
    mockGetActivePlan.mockResolvedValue(ACTIVE_UNACCEPTED);
    const handler = vi.fn(async () => ({ success: true, output: "must not run" }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);
    recordDiscoveredTools(SESSION, [MUTATING_TOOL_ID]);
    const context = makeTestContext({ sessionId: SESSION, planMode: true });

    const viaCanonical = await dispatchTool(
      { name: MUTATING_CANONICAL, args: { amount: "1", to: "0xabc" }, toolCallId: "g1" },
      context,
    );
    const viaAlias = await dispatchTool(
      { name: MUTATING_DEPRECATED, args: { amount: "1", to: "0xabc" }, toolCallId: "g2" },
      context,
    );

    // The DECISION is what must be identical: both spellings are blocked, and
    // neither reaches the handler. The message names the tool by the spelling
    // the model used, so it can match the block to its own call.
    expect(viaCanonical.success).toBe(false);
    expect(viaAlias.success).toBe(false);
    expect(viaCanonical.output).toMatch(/Plan mode is on/);
    expect(viaAlias.output).toMatch(/Plan mode is on/);
    expect(viaAlias.actionKind).toBe(viaCanonical.actionKind);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows the deprecated name of a READ target exactly as the canonical name", async () => {
    mockGetActivePlan.mockResolvedValue(ACTIVE_UNACCEPTED);
    const handler = vi.fn(async () => ({ success: true, output: "read ok" }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);
    recordDiscoveredTools(SESSION, [READ_TOOL_ID]);
    const context = makeTestContext({ sessionId: SESSION, planMode: true });

    const viaCanonical = await dispatchTool(
      { name: READ_CANONICAL, args: { query: "VEX" }, toolCallId: "g3" },
      context,
    );
    const viaAlias = await dispatchTool(
      { name: READ_DEPRECATED, args: { query: "VEX" }, toolCallId: "g4" },
      context,
    );

    expect(viaCanonical.success).toBe(true);
    expect(viaAlias.success).toBe(true);
    expect(viaAlias.output).toBe(viaCanonical.output);
  });
});

// ── (iii) approval enqueue: stored envelope + fingerprint ─────────

describe("alias equivalence: approval enqueue envelope and fingerprint", () => {
  const ARGS = { amount: "1", to: "0xabc" };

  it("stores the CANONICAL identity and fingerprint for a deprecated protocol name", () => {
    const viaCanonical = buildApprovalToolCall(MUTATING_CANONICAL, ARGS);
    const viaAlias = buildApprovalToolCall(MUTATING_DEPRECATED, ARGS);

    expect(viaCanonical).toMatchObject({
      command: "execute_tool",
      args: { toolId: MUTATING_TOOL_ID, params: ARGS },
    });
    // Dispatchable content is identical: the durable row cannot carry a name
    // the runtime will have retired by the time a cold resume reads it.
    expect(viaAlias.command).toBe(viaCanonical.command);
    expect(viaAlias.args).toEqual(viaCanonical.args);

    const canonicalVex = viaCanonical.vex as Record<string, unknown>;
    const aliasVex = viaAlias.vex as Record<string, unknown>;
    expect(aliasVex.v).toBe(canonicalVex.v);
    // The fingerprint binds to the manifest the human approved, the same one
    // either spelling denotes.
    expect(aliasVex.manifestFingerprint).toBe(canonicalVex.manifestFingerprint);
    expect(aliasVex.manifestFingerprint).toBe(computeManifestFingerprint(mutatingManifest()));
    // Audit only: `originalToolName` deliberately preserves the RAW spelling
    // the model emitted, which is the whole point of the field.
    expect(aliasVex.originalToolName).toBe(MUTATING_DEPRECATED);
    expect(canonicalVex.originalToolName).toBe(MUTATING_CANONICAL);
  });

  it("stores the IMMUTABLE dotted toolId for a target-grammar name, not an inversion", () => {
    const args = { chain: "base" };
    const stored = buildApprovalToolCall(GRAMMAR_DEPRECATED, args);

    // THE REGRESSION. `kyberswap__swap_quote` carries exactly one double
    // underscore, so a mechanical inverse mapping would write
    // `kyberswap.SwapQuote` into a DURABLE approval row and hash it into the
    // fingerprint that is supposed to prove the human approved this contract.
    expect(stored).toMatchObject({
      command: "execute_tool",
      args: { toolId: GRAMMAR_TOOL_ID, params: args },
    });
    expect(JSON.stringify(stored)).not.toContain(GRAMMAR_WRONG_INVERSION);

    // The fingerprint is the real manifest's, so a cold resume verifies against
    // the contract that was actually approved.
    const vex = stored.vex as Record<string, unknown>;
    expect(vex.manifestFingerprint).toBe(computeManifestFingerprint(grammarManifest()));
    expect(vex.originalToolName).toBe(GRAMMAR_DEPRECATED);
  });

  it("canonicalizes the stored command for a deprecated INTERNAL tool name", () => {
    // No manifest behind it, so the `{command, args}` lane applies, and the
    // command must still be the canonical name, because that is what a cold
    // resume will re-dispatch.
    expect(buildApprovalToolCall(PRESSURE_DEPRECATED, ARGS)).toEqual({
      command: PRESSURE_CANONICAL,
      args: ARGS,
    });
  });
});

// ── (iv) approval preview ─────────────────────────────────────────

describe("alias equivalence: approval preview", () => {
  it("shows the canonical identity for a deprecated protocol name", () => {
    const args = { amount: "1", to: "0xabc" };
    const viaCanonical = buildIntentPreview(MUTATING_CANONICAL, args);
    const viaAlias = buildIntentPreview(MUTATING_DEPRECATED, args);

    // The human sees the dotted toolId, never the retired model-visible name.
    expect(viaCanonical.toolName).toBe(MUTATING_TOOL_ID);
    expect(viaAlias).toEqual(viaCanonical);
    expect(JSON.stringify(viaAlias)).not.toContain(MUTATING_DEPRECATED);
  });
});

// ── (v) cold approval resume ──────────────────────────────────────

describe("alias equivalence: cold approval resume", () => {
  /**
   * `dispatch-approved.ts` re-enters `dispatchTool` with the name stored in
   * `approval_queue.tool_call`, on a host-built context that is approved and
   * NOT model-originated. Two stored shapes can carry a name across a restart,
   * and both are exercised here:
   *
   *   - the canonicalized `execute_tool {toolId, params}` envelope, which is
   *     what an injected protocol call is always stored as (precisely because
   *     the injected lane is gated on the process-local discovered set);
   *   - `{command: <internal tool name>}` for every other lane.
   */

  it("resumes a row whose envelope was built from the deprecated name", async () => {
    const handler = vi.fn(async (params: Record<string, unknown>) => ({
      success: true,
      output: `resumed with ${JSON.stringify(params)}`,
    }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);
    // A COLD process: nothing was discovered in this session, exactly as after
    // a restart. The resume must not depend on the discovered set.
    clearDiscoveredTools(SESSION);

    const stored = buildApprovalToolCall(MUTATING_DEPRECATED, { amount: "1", to: "0xabc" });
    const result = await dispatchTool(
      {
        name: stored.command as string,
        args: stored.args as Record<string, unknown>,
        toolCallId: "approval-1",
      },
      makeTestContext({ sessionId: SESSION, approved: true }),
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const [firstCall] = handler.mock.calls;
    assert.ok(firstCall);
    expect(firstCall[0]).toEqual({ amount: "1", to: "0xabc" });
    expect(result.actionKind).toBe("user_wallet_broadcast");
  });

  it("resumes a `{command}` row stored under a deprecated INTERNAL name", async () => {
    clearDiscoveredTools(SESSION);
    const context = makeTestContext({ sessionId: SESSION, approved: true });

    // Deliberately un-routable args, so the assertion is about WHICH ROUTE the
    // stored name reached, not about the swap router's own behaviour. The
    // canonical and deprecated spellings must be answered identically.
    const viaCanonical = await dispatchTool(
      { name: PRESSURE_CANONICAL, args: {}, toolCallId: "approval-2a" },
      context,
    );
    const viaAlias = await dispatchTool(
      { name: PRESSURE_DEPRECATED, args: {}, toolCallId: "approval-2b" },
      context,
    );

    expectSameResult(viaAlias, viaCanonical);
    // The stale name reached the real route: it is NOT answered as unknown,
    // which is what a resume without alias resolution would have produced.
    expect(viaAlias.output).not.toMatch(/^Unknown tool/);
    expect(viaAlias.output).not.toContain(PRESSURE_DEPRECATED);
  });

  it("answers a deprecated INJECTED name in a cold process exactly as the canonical name", async () => {
    clearDiscoveredTools(SESSION);
    const context = makeTestContext({ sessionId: SESSION, approved: true });

    // Neither spelling is callable directly in a cold process: the injected
    // lane is session-scoped by design. What matters is that the deprecated
    // name gets the SAME by-name discovery answer, not the generic unknown-tool
    // line it would have got without resolution.
    const viaCanonical = await dispatchTool(
      { name: MUTATING_CANONICAL, args: {}, toolCallId: "approval-3a" },
      context,
    );
    const viaAlias = await dispatchTool(
      { name: MUTATING_DEPRECATED, args: {}, toolCallId: "approval-3b" },
      context,
    );

    expect(viaCanonical.success).toBe(false);
    expect(viaCanonical.output).toContain("not among the protocol tools this session has made callable");
    expect(viaAlias.success).toBe(viaCanonical.success);

    // The two refusals are NOT byte-identical, and deliberately so: each names
    // the tool by the spelling the caller actually used, so the model can match
    // the refusal to its own call.
    expect(viaAlias.output).toContain(`Unknown tool: ${MUTATING_DEPRECATED}`);
    expect(viaCanonical.output).toContain(`Unknown tool: ${MUTATING_CANONICAL}`);

    // What must be IDENTICAL is the remedy: both point at the canonical
    // CALLABLE name, because selecting a retired spelling cannot succeed — and
    // the dotted toolId is not something the model can call either, so the hint
    // names neither the alias nor the id.
    const hint = `Call ToolSearch(query="select:${MUTATING_CANONICAL}")`;
    expect(viaAlias.output).toContain(hint);
    expect(viaCanonical.output).toContain(hint);
  });
});

// ── catalog selection (the resolver a future ToolSearch consumes) ──

describe("alias equivalence: protocol catalog selection", () => {
  it("resolves a deprecated name to the same manifest as the canonical name", () => {
    expect(resolveInjectedProtocolTool(READ_DEPRECATED)).toEqual(
      resolveInjectedProtocolTool(READ_CANONICAL),
    );
    expect(resolveInjectedProtocolTool(MUTATING_DEPRECATED)?.toolId).toBe(MUTATING_TOOL_ID);
  });

  it("returns undefined for an unknown name, unchanged", () => {
    expect(resolveInjectedProtocolTool("not_an_alias_at_all")).toBeUndefined();
  });

  it("resolves a target-grammar name from the table, never by inverting it", () => {
    expect(resolveInjectedProtocolTool(GRAMMAR_DEPRECATED)?.toolId).toBe(GRAMMAR_TOOL_ID);
    // The catalog is stubbed to know nothing about the inverted spelling, so a
    // resolver that inverted the name would return undefined here.
    expect(catalog.getProtocolManifest(GRAMMAR_WRONG_INVERSION)).toBeUndefined();
  });
});
