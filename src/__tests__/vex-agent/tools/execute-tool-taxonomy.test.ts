/**
 * `execute_tool` taxonomy propagation — protocol target classifier read +
 * `ToolResult.actionKind` stamp on every known-manifest return path.
 *
 * Puzzle 5 phase 1B (2026-05-23). Surfaces under test:
 *
 *  1. `executeProtocolTool` reads `manifest.actionKind` directly (phase 1A's
 *     heuristic `deriveProtocolActionKind` is gone — see commit ff019d5 →
 *     this phase). Preview / dryRun overrides to `"read"` regardless of the
 *     manifest's classification (Codex 1A Q3 ruling preserved).
 *
 *  2. Stamp propagation: every code path that returns a `ToolResult` with a
 *     known manifest stamps `actionKind`. The unknown-manifest path
 *     intentionally omits the field so the dispatcher / policy layer can
 *     treat absent `actionKind` as the conservative "unknown" signal.
 *
 *  3. Handler-set `actionKind` is overwritten by the manifest classifier —
 *     a buggy or malicious handler cannot downgrade a
 *     `user_wallet_broadcast` mutation to `read` (Codex 1A final review).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeProtocolContext } from "./_test-context.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

// ── Mock surface ──────────────────────────────────────────────────────
//
// `isPreviewExecution` is read by `executeProtocolTool` for both the
// preview-actionKind override and the approval-gate skip — controlling it
// per-test keeps each case independent of `MUTATION_MATRIX` state.
//
// `validateCaptureContract` defaults to true (we don't exercise capture
// pipeline in these tests).
vi.mock("@vex-agent/tools/protocols/capture-validator.js", () => ({
  isPreviewExecution: vi.fn(() => false),
  validateCaptureContract: vi.fn(() => true),
}));

// Catalog lookups — per-test override of which manifest / handler is returned.
// Partial mock via `importOriginal` so dependents that import other exports
// (e.g. `PROTOCOL_TOOLS` from lexical-score) still resolve them.
vi.mock("@vex-agent/tools/protocols/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return {
    ...actual,
    getProtocolManifest: vi.fn(),
    getProtocolHandler: vi.fn(),
  };
});

// Namespace lifecycle — pretend the test namespace is always executable.
vi.mock("@vex-agent/tools/protocols/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/lifecycle.js")>();
  return {
    ...actual,
    isExecutableNamespace: vi.fn(() => true),
  };
});

// Capture pipeline + DB writes — no-ops in unit tests. We use full mocks
// only where leaving real exports in place would force a DB connection.
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

vi.mock("@vex-agent/db/params.js", () => ({
  sanitizeJsonbValue: (v: unknown) => v,
}));

// ── Dynamic imports after mocks are registered ───────────────────────

const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
const catalog = await import("@vex-agent/tools/protocols/catalog.js");
const captureValidator = await import("@vex-agent/tools/protocols/capture-validator.js");

// ── Fixtures ─────────────────────────────────────────────────────────

/**
 * Build a fake `ProtocolToolManifest`. Default `actionKind: "read"` keeps
 * the fixture valid for non-mutating cases; each mutating-test overrides it.
 */
function makeManifest(overrides: Partial<ProtocolToolManifest> = {}): ProtocolToolManifest {
  return {
    toolId: "test.fake.tool",
    publicName: "test__fake_tool",
    namespace: "khalani",
    lifecycle: "active",
    description: "fake",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(captureValidator.isPreviewExecution).mockReturnValue(false);
  vi.mocked(catalog.getProtocolManifest).mockReset();
  vi.mocked(catalog.getProtocolHandler).mockReset();
});

// ── executeProtocolTool — stamp propagation per return path ──────────

const ctx = makeProtocolContext({ sessionId: "test-session" });

describe("executeProtocolTool — actionKind propagation", () => {
  it("omits actionKind when manifest is unknown (conservative undefined)", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(undefined);

    const result = await executeProtocolTool(
      { toolId: "unknown.tool", params: {} },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.actionKind).toBeUndefined();
  });

  it("stamps actionKind from manifest on missing-required-param return path", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({
        toolId: "test.high",
        mutating: true,
        actionKind: "user_wallet_broadcast",
        params: [{ key: "to", type: "string", required: true, description: "" }],
      }),
    );

    const result = await executeProtocolTool(
      { toolId: "test.high", params: {} }, // missing `to`
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Missing required parameter/);
    expect(result.actionKind).toBe("user_wallet_broadcast");
  });

  it("stamps actionKind from manifest on approval-required path (mutating + restricted + !approved)", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({
        toolId: "test.external",
        mutating: true,
        actionKind: "external_post",
      }),
    );
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(async () => ({
      success: true, output: "should not be called",
    }));

    const result = await executeProtocolTool(
      { toolId: "test.external", params: {} },
      ctx, // restricted + !approved
    );

    expect(result.pendingApproval).toBe(true);
    expect(result.actionKind).toBe("external_post");
  });

  it("stamps actionKind from manifest on pressure-denied path (mutating + barrier)", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({
        toolId: "test.high.barrier",
        mutating: true,
        actionKind: "user_wallet_broadcast",
      }),
    );

    const result = await executeProtocolTool(
      { toolId: "test.high.barrier", params: {} },
      { ...ctx, contextUsageBand: "barrier" },
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/blocked at context pressure/);
    expect(result.actionKind).toBe("user_wallet_broadcast");
  });

  it("stamps actionKind from manifest on successful handler return", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({ toolId: "test.read", mutating: false, actionKind: "read" }),
    );
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(async () => ({
      success: true, output: "ok",
    }));

    const result = await executeProtocolTool(
      { toolId: "test.read", params: {} },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.actionKind).toBe("read");
  });

  it("stamps actionKind from manifest on handler-thrown failure", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({
        toolId: "test.throw",
        mutating: true,
        actionKind: "user_wallet_broadcast",
      }),
    );
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(async () => {
      throw new Error("network down");
    });

    const result = await executeProtocolTool(
      { toolId: "test.throw", params: {} },
      { ...ctx, approved: true }, // bypass approval gate so we reach the handler
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/network down/);
    expect(result.actionKind).toBe("user_wallet_broadcast");
  });

  it("handler-set actionKind cannot override the manifest classifier", async () => {
    // Codex final review puzzle 5/1A (2026-05-23): for protocol tools the
    // manifest-driven classifier is the source of truth. A buggy or
    // malicious handler returning `actionKind: "read"` on a mutating
    // user-wallet-broadcast tool MUST NOT downgrade the policy
    // classification.
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({
        toolId: "test.override",
        mutating: true,
        actionKind: "user_wallet_broadcast",
      }),
    );
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(async () => ({
      success: true,
      output: "lying about kind",
      actionKind: "read", // handler tries to downgrade
    }));

    const result = await executeProtocolTool(
      { toolId: "test.override", params: {} },
      { ...ctx, approved: true }, // bypass approval gate so we reach the handler
    );

    expect(result.success).toBe(true);
    expect(result.actionKind).toBe("user_wallet_broadcast"); // manifest wins
  });

  it("stamps 'read' on preview-execution return path even when manifest is mutating", async () => {
    // Preview / dryRun override per Codex 1A Q3 — read-only simulation
    // regardless of the manifest's classification. The approval gate also
    // skips preview, so the override stays consistent end-to-end.
    vi.mocked(captureValidator.isPreviewExecution).mockReturnValue(true);
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({
        toolId: "test.preview",
        mutating: true,
        actionKind: "user_wallet_broadcast",
      }),
    );
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(async () => ({
      success: true, output: "simulated", data: { dryRun: true },
    }));

    const result = await executeProtocolTool(
      { toolId: "test.preview", params: { dryRun: true } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.actionKind).toBe("read");
  });
});
