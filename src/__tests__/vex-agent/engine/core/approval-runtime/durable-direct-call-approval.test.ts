/**
 * A0.3 — an approval enqueued from an INJECTED DIRECT CALL must survive a
 * process restart.
 *
 * THE DEFECT this pins. A discovered protocol tool is offered to the model as a
 * real function (`kyberswap__swap__execute`) and the injected dispatch lane
 * refuses any such name that is not in the SESSION-SCOPED, PROCESS-LOCAL
 * discovered set. Storing that function name in `approval_queue.tool_call` made
 * the approval only as durable as the process: after a restart the set is
 * empty, and the human's click on Approve failed a money-path action that had
 * already passed every gate — "not among the protocol tools this session has made callable" in this
 * session".
 *
 * THE FIX. At enqueue the call is canonicalized into the internal
 * `execute_tool {toolId, params}` envelope inside the SAME JSONB field, so the
 * cold resume resolves its manifest from the durable catalog. The tests below
 * simulate the fresh process by wiping the discovered set between enqueue and
 * resume — which is exactly what a restart does.
 *
 * Mocks mirror `tools/dispatcher-injected-protocol.test.ts`: the catalog is
 * stubbed so the manifest under test is synthetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ProtocolHandler,
  ProtocolToolManifest,
} from "@vex-agent/tools/protocols/types.js";

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
const { getToolDef } = await import("@vex-agent/tools/registry/lookup.js");
const { clearDiscoveredTools, recordDiscoveredTools } = await import(
  "@vex-agent/tools/registry/discovered-tools.js"
);
const {
  buildApprovalToolCall,
  checkApprovalManifestIdentity,
  computeManifestFingerprint,
} = await import("@vex-agent/engine/core/approval-runtime/tool-call-envelope.js");
const { makeTestContext } = await import("../../../tools/_test-context.js");

const SESSION = "durable-approval-session";
// A REAL (toolId, publicName) pair. The injected-name to toolId map is built
// once from the LIVE catalog, so a synthetic publicName resolves to nothing and
// the canonicalization under test would never run. `morpho.rewards.claim` is
// mutating (which is what the envelope branches on) and carries no
// prequote-registry entry, so the cold-resume dispatch below exercises the
// envelope rather than an unrelated quote gate.
const TOOL_ID = "morpho.rewards.claim";
const INJECTED_NAME = "morpho__rewards_claim";
const SWAP_PARAMS = {
  chain: "base",
  tokenIn: "0xaaa",
  tokenOut: "0xbbb",
  amountIn: "1.5",
  slippageBps: 100,
};

function makeManifest(overrides: Partial<ProtocolToolManifest> = {}): ProtocolToolManifest {
  return {
    toolId: TOOL_ID,
    publicName: INJECTED_NAME,
    namespace: "morpho",
    lifecycle: "active",
    description: "swap execute",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "chain", type: "string", required: true, description: "" },
      { key: "tokenIn", type: "string", required: true, description: "" },
      { key: "tokenOut", type: "string", required: true, description: "" },
      { key: "amountIn", type: "string", required: true, description: "" },
      { key: "slippageBps", type: "number", required: false, unit: "bps", description: "" },
    ],
    exampleParams: {},
    ...overrides,
  };
}

/** The context a COLD RESUME dispatches under — approved, host-built, no model provenance. */
const resumedContext = makeTestContext({
  sessionId: SESSION,
  approved: true,
  sessionPermission: "restricted",
  approvalId: "approval-1",
});

beforeEach(() => {
  clearDiscoveredTools(SESSION);
  vi.mocked(catalog.getProtocolManifest).mockReset();
  vi.mocked(catalog.getProtocolHandler).mockReset();
});

describe("approval enqueue — direct-call canonicalization", () => {
  it("stores an injected direct call as the execute_tool envelope with a manifest fingerprint", () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());

    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    expect(stored).toEqual({
      command: "execute_tool",
      args: { toolId: TOOL_ID, params: SWAP_PARAMS },
      vex: {
        v: 2,
        originalToolName: INJECTED_NAME,
        manifestFingerprint: computeManifestFingerprint(makeManifest()),
      },
    });
  });

  it("leaves every other lane's stored shape byte-identical", () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(undefined);

    expect(buildApprovalToolCall("WalletSendConfirm", { id: "x" }))
      .toEqual({ command: "WalletSendConfirm", args: { id: "x" } });
    expect(buildApprovalToolCall("SwapExecute", { chain: "base" }))
      .toEqual({ command: "SwapExecute", args: { chain: "base" } });
  });
});

describe("cold resume after a process restart", () => {
  it("executes the target handler with IDENTICAL params once the discovered set is empty", async () => {
    const manifest = makeManifest();
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(manifest);
    const handler = vi.fn<ProtocolHandler>(async () => ({
      success: true,
      output: "swapped",
    }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

    // ── live turn: the model discovers the tool and calls it by name ──
    recordDiscoveredTools(SESSION, [TOOL_ID]);
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    // ── the process restarts: nothing was discovered in the new one ──
    clearDiscoveredTools(SESSION);

    // THE RETIREMENT AND THIS RESUME ARE ONE CONTRACT, so they are asserted
    // together. `execute_tool` has no `ToolDef` any more (the ToolSearch merge
    // deleted it, `registry/protocol.ts`), and the stored envelope must STILL
    // dispatch: it is a stored-call SHAPE, not a registered tool. If a future
    // change ever routes dispatch through the registry, this line is what turns
    // "an approved, human-authorized, fund-moving call silently stops resuming"
    // into a test failure.
    expect(getToolDef("execute_tool")).toBeUndefined();

    const result = await dispatchTool(
      {
        name: stored.command as string,
        args: stored.args as Record<string, unknown>,
        toolCallId: "tc-resume",
      },
      resumedContext,
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual(SWAP_PARAMS);
  });

  /*
   * THE OPTIONAL EMPTY LIST, ACROSS THE APPROVAL BOUNDARY (2026-08-28).
   *
   * `normalizeOptionalEmptyArrayParams` drops an optional `acceptsStringArray`
   * param whose value is `[]`. It runs inside `executeProtocolTool`, which is
   * AFTER the point where the turn loop captured `toolCall.arguments` for the
   * approval row - so the durable envelope stores the raw model spelling.
   *
   * That is the CORRECT and deliberate contract, and these cases pin it, because
   * "the envelope should store the normalized args instead" is the intuitive
   * reading and it is wrong on this codebase:
   *
   *   - the envelope is a DURABLE record whose bytes are the `request_digest`
   *     preimage (`computeRequestDigest`), and it is documented as the ORIGINAL
   *     arguments object. The other runtime normalizations - flat-args
   *     resolution, the JSON-string array coercion, the numeric-string coercion
   *     - are likewise NOT stored and re-applied on the execute side. (The one
   *     exception is the retired-alias rewrite, which param-aliases.ts
   *     deliberately mutates in place BEFORE capture so the row stores the
   *     canonical key; that is a spelling migration, not a semantic transform.)
   *   - resume re-dispatches BY NAME with the stored args, so the identical
   *     normalization runs again in the resuming process. Preview, digest and
   *     execution are consistent because the transform is deterministic and
   *     re-run, not because it was baked into the row.
   *
   * What must therefore be true, and is asserted below: whichever spelling of
   * "no filter" the model used, the HANDLER sees the same params after a cold
   * resume, and the empty key never reaches it.
   */
  const LIST_MANIFEST_OVERRIDE: Partial<ProtocolToolManifest> = {
    params: [
      { key: "chain", type: "string", required: true, description: "" },
      {
        key: "marketIds",
        type: "string",
        required: false,
        acceptsStringArray: true,
        description: "",
      },
    ],
  };

  it.each([
    ["a real empty array", [] as unknown],
    ["the JSON-string spelling", "[]" as unknown],
  ])("drops an optional empty list at cold resume when the row stored %s", async (_label, sent) => {
    const manifest = makeManifest(LIST_MANIFEST_OVERRIDE);
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(manifest);
    const handler = vi.fn<ProtocolHandler>(async () => ({ success: true, output: "claimed" }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

    const sentParams = { chain: "base", marketIds: sent };
    recordDiscoveredTools(SESSION, [TOOL_ID]);
    const stored = buildApprovalToolCall(INJECTED_NAME, sentParams);

    // The row keeps the model's own spelling, verbatim - it is the digest
    // preimage and must not be rewritten behind the human's approval.
    expect(stored.args).toEqual({ toolId: TOOL_ID, params: sentParams });

    clearDiscoveredTools(SESSION);
    const result = await dispatchTool(
      {
        name: stored.command as string,
        args: stored.args as Record<string, unknown>,
        toolCallId: "tc-empty-list",
      },
      resumedContext,
    );

    expect(result.success).toBe(true);
    // THE POINT: execution is identical for both spellings, and the empty
    // filter never reaches the handler.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({ chain: "base" });
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("marketIds");
  });

  it("REGRESSION: the raw injected name is what used to fail in a fresh process", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    const handler = vi.fn<ProtocolHandler>(async () => ({
      success: true,
      output: "swapped",
    }));
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

    const result = await dispatchTool(
      { name: INJECTED_NAME, args: SWAP_PARAMS, toolCallId: "tc-old" },
      resumedContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("not among the protocol tools this session has made callable");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("manifest identity at resume", () => {
  it("passes when the manifest is unchanged", () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    expect(checkApprovalManifestIdentity(stored)).toEqual({ ok: true });
  });

  it("passes when only DESCRIPTION prose changed — churn must not strand an approval", () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({ description: "completely rewritten prose for W7" }),
    );
    expect(checkApprovalManifestIdentity(stored)).toEqual({ ok: true });
  });

  it("passes when params are merely REORDERED", () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({ params: [...makeManifest().params].reverse() }),
    );
    expect(checkApprovalManifestIdentity(stored)).toEqual({ ok: true });
  });

  it.each([
    [
      "a param became required",
      makeManifest({
        params: makeManifest().params.map((p) =>
          p.key === "slippageBps" ? { ...p, required: true } : p,
        ),
      }),
    ],
    [
      "a param changed type",
      makeManifest({
        params: makeManifest().params.map((p) =>
          p.key === "amountIn" ? { ...p, type: "number" as const } : p,
        ),
      }),
    ],
    [
      "a param lost its unit",
      makeManifest({
        params: makeManifest().params.map((p) =>
          p.key === "slippageBps" ? { key: p.key, type: p.type, description: "" } : p,
        ),
      }),
    ],
    ["a new param appeared", makeManifest({
      params: [
        ...makeManifest().params,
        { key: "recipient", type: "string" as const, required: true, description: "" },
      ],
    })],
    ["the action kind changed", makeManifest({ actionKind: "read" })],
    ["mutating changed", makeManifest({ mutating: false })],
    // ── v2 field families: every rule that decides whether a call is ADMITTED.
    ["a param gained an enum", makeManifest({
      params: makeManifest().params.map((p) =>
        p.key === "chain" ? { ...p, enum: ["base", "arbitrum"] as const } : p,
      ),
    })],
    ["a param started accepting a string array", makeManifest({
      params: makeManifest().params.map((p) =>
        p.key === "tokenIn" ? { ...p, acceptsStringArray: true as const } : p,
      ),
    })],
    ["an exclusiveParamGroups group appeared", makeManifest({
      exclusiveParamGroups: [["tokenIn", "tokenOut"]],
    })],
    ["an atMostOne group appeared", makeManifest({
      atMostOne: [["tokenIn", "tokenOut"]],
    })],
    ["an atLeastOneOf group appeared", makeManifest({
      atLeastOneOf: [["tokenIn", "tokenOut"]],
    })],
  ])("FAILS CLOSED when %s", (_label, changed) => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    vi.mocked(catalog.getProtocolManifest).mockReturnValue(changed);
    const verdict = checkApprovalManifestIdentity(stored);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("manifest_fingerprint_mismatch");
    expect(verdict.refusal).toContain("Nothing was executed");
    expect(verdict.refusal).toContain("fresh approval");
  });

  it("FAILS CLOSED when an enum LOSES a member — the approved value may now be illegal", () => {
    const enumManifest = (values: readonly string[]) => makeManifest({
      params: makeManifest().params.map((p) => (p.key === "chain" ? { ...p, enum: values } : p)),
    });
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(enumManifest(["base", "arbitrum"]));
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    vi.mocked(catalog.getProtocolManifest).mockReturnValue(enumManifest(["base"]));
    expect(checkApprovalManifestIdentity(stored)).toMatchObject({
      ok: false,
      reason: "manifest_fingerprint_mismatch",
    });
  });

  it("FAILS CLOSED when a group's MEMBERSHIP changes, not merely its order", () => {
    const grouped = (group: readonly string[]) => makeManifest({ atMostOne: [group] });
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(grouped(["tokenIn", "tokenOut"]));
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    // Reordering the same members is not a contract change.
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(grouped(["tokenOut", "tokenIn"]));
    expect(checkApprovalManifestIdentity(stored)).toEqual({ ok: true });

    vi.mocked(catalog.getProtocolManifest).mockReturnValue(grouped(["tokenOut", "amountIn"]));
    expect(checkApprovalManifestIdentity(stored)).toMatchObject({
      ok: false,
      reason: "manifest_fingerprint_mismatch",
    });
  });

  // CORRECTED (Codex final review, 2026-08-03). This previously asserted that a
  // reordered enum was the same contract. It is not: `runtime/params.ts`
  // normalizes a chain-valued enum to the FIRST case-insensitive match, so
  // declaration order decides which spelling the handler receives. Treating the
  // reorder as identical let a queued approval resume against a contract that
  // hands the handler a different value than the one the human saw — the exact
  // silent substitution the fingerprint exists to prevent.
  it("FAILS CLOSED when an enum is reordered — declaration order decides the handler-visible value", () => {
    const enumManifest = (values: readonly string[]) => makeManifest({
      params: makeManifest().params.map((p) => (p.key === "chain" ? { ...p, enum: values } : p)),
    });
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(enumManifest(["base", "arbitrum"]));
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    vi.mocked(catalog.getProtocolManifest).mockReturnValue(enumManifest(["arbitrum", "base"]));
    expect(checkApprovalManifestIdentity(stored)).toMatchObject({
      ok: false,
      reason: "manifest_fingerprint_mismatch",
    });

    // The identical declaration still resumes — the rule is "order as declared",
    // not "any enum invalidates".
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(enumManifest(["base", "arbitrum"]));
    expect(checkApprovalManifestIdentity(stored)).toEqual({ ok: true });
  });

  it("FAILS CLOSED on a v1 metadata block — its hash never saw the v2 fields", () => {
    const verdict = checkApprovalManifestIdentity({
      command: "execute_tool",
      args: { toolId: TOOL_ID, params: SWAP_PARAMS },
      vex: { v: 1, originalToolName: INJECTED_NAME, manifestFingerprint: "deadbeef" },
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("envelope_version_superseded");
    expect(verdict.refusal).toContain("Nothing was executed");
    expect(verdict.refusal).toContain("fresh approval");
  });

  it("FAILS CLOSED when the tool no longer exists", () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(makeManifest());
    const stored = buildApprovalToolCall(INJECTED_NAME, SWAP_PARAMS);

    vi.mocked(catalog.getProtocolManifest).mockReturnValue(undefined);
    const verdict = checkApprovalManifestIdentity(stored);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("manifest_missing");
    expect(verdict.refusal).toContain(TOOL_ID);
  });

  it("replays HISTORICAL rows unchanged — no metadata block, no identity check", () => {
    expect(checkApprovalManifestIdentity({ command: "execute_tool", args: { toolId: TOOL_ID } }))
      .toEqual({ ok: true });
    expect(checkApprovalManifestIdentity({ command: "WalletSendConfirm", args: {} }))
      .toEqual({ ok: true });
    // Legacy `{name, arguments}` spelling — also untouched.
    expect(checkApprovalManifestIdentity({ name: "WalletSendConfirm", arguments: {} }))
      .toEqual({ ok: true });
    // And the PRE-RENAME spelling, which is what a row written before the
    // Batch 2 core rename literally holds on disk. `approval_queue.tool_call`
    // is durable and is never rewritten, so this is not a hypothetical: it is
    // the row a cold resume in a later process actually reads back.
    expect(checkApprovalManifestIdentity({ command: "WalletSendConfirm", args: {} }))
      .toEqual({ ok: true });
    expect(checkApprovalManifestIdentity({ name: "WalletSendConfirm", arguments: {} }))
      .toEqual({ ok: true });
  });

  it("FAILS CLOSED on an unreadable metadata block rather than dispatching blind", () => {
    const verdict = checkApprovalManifestIdentity({
      command: "execute_tool",
      args: { toolId: TOOL_ID, params: {} },
      vex: { v: 99, manifestFingerprint: "" },
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("envelope_metadata_unreadable");
  });
});
