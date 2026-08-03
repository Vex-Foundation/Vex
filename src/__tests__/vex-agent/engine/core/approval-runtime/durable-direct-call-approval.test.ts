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
 * already passed every gate — "not among the protocol tools discovered in this
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
const TOOL_ID = "khalani.test.mutate";
const INJECTED_NAME = "khalani__test__mutate";
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
    namespace: "khalani",
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
        v: 1,
        originalToolName: INJECTED_NAME,
        manifestFingerprint: computeManifestFingerprint(makeManifest()),
      },
    });
  });

  it("leaves every other lane's stored shape byte-identical", () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(undefined);

    expect(buildApprovalToolCall("wallet_send_confirm", { id: "x" }))
      .toEqual({ command: "wallet_send_confirm", args: { id: "x" } });
    expect(buildApprovalToolCall("swap_execute", { chain: "base" }))
      .toEqual({ command: "swap_execute", args: { chain: "base" } });
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
    expect(result.output).toContain("not among the protocol tools discovered");
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
    expect(checkApprovalManifestIdentity({ command: "wallet_send_confirm", args: {} }))
      .toEqual({ ok: true });
    // Legacy `{name, arguments}` spelling — also untouched.
    expect(checkApprovalManifestIdentity({ name: "wallet_send_confirm", arguments: {} }))
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
