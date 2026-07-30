/**
 * `compact_apply` handler — the tool NEVER performs a cutover, and it never
 * claims one happened.
 *
 * Both properties are agent-facing correctness, not cosmetics: a `queued`
 * reported as "done" makes the model plan its next turn against a context
 * budget it does not have, and an `engineSignal: compact_committed` would abort
 * the rest of the tool batch for a compaction that has not occurred.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequestApply = vi.fn();
vi.mock("../../../../vex-agent/engine/compaction/apply/index.js", () => ({
  requestApply: (...a: unknown[]) => mockRequestApply(...a),
}));

const { handleCompactApply } = await import(
  "../../../../vex-agent/tools/internal/compact/apply.js"
);

function ctx(over: Record<string, unknown> = {}): never {
  return {
    sessionId: "s-1",
    loadedDocuments: new Map(),
    sessionPermission: "restricted",
    approved: false,
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    planMode: false,
    contextUsageBand: "barrier",
    walletResolution: { source: "session", address: null },
    walletPolicy: { kind: "none" },
    ...over,
  } as never;
}

describe("handleCompactApply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to requestApply as `agent_tool` and performs no cutover itself", async () => {
    mockRequestApply.mockResolvedValue({ kind: "queued", preparationId: 3 });

    await handleCompactApply({}, ctx());

    expect(mockRequestApply).toHaveBeenCalledWith({
      sessionId: "s-1",
      source: "agent_tool",
    });
  });

  it("NEVER returns an engineSignal on any outcome", async () => {
    // `compact_committed` aborts the remaining tool batch. Nothing is committed
    // here, so emitting it would discard the agent's other calls for free.
    const outcomes = [
      { kind: "queued", preparationId: 1 },
      { kind: "queued_no_live_runner", preparationId: 1 },
      { kind: "already_requested", preparationId: 1 },
      { kind: "not_ready", preparationId: 1, status: "preparing" },
      { kind: "no_preparation" },
    ];
    for (const o of outcomes) {
      mockRequestApply.mockResolvedValue(o);
      const result = await handleCompactApply({}, ctx());
      expect(result.engineSignal, o.kind).toBeUndefined();
    }
  });

  it("`queued` is reported as queued — never as an already-smaller context", async () => {
    mockRequestApply.mockResolvedValue({ kind: "queued", preparationId: 3 });

    const result = await handleCompactApply({}, ctx());

    expect(result.success).toBe(true);
    expect(result.output).toContain("queued");
    expect(result.output).toContain("NOT smaller yet");
  });

  it("`queued_no_live_runner` is honest and still a success — the request is durable", async () => {
    mockRequestApply.mockResolvedValue({
      kind: "queued_no_live_runner",
      preparationId: 3,
    });

    const result = await handleCompactApply({}, ctx());

    expect(result.success).toBe(true);
    expect(result.output).toContain("no runner is currently active");
    expect(result.output).toContain("not lost");
    expect(result.data).toMatchObject({ no_live_runner: true });
  });

  it("`already_requested` adds nothing and says so", async () => {
    mockRequestApply.mockResolvedValue({
      kind: "already_requested",
      preparationId: 3,
    });

    const result = await handleCompactApply({}, ctx());

    expect(result.success).toBe(true);
    expect(result.output).toContain("already queued");
  });

  it("refusals are `success: false` and tell the agent NOT to retry", async () => {
    for (const outcome of [
      { kind: "not_ready", preparationId: 1, status: "preparing" },
      { kind: "no_preparation" },
    ]) {
      mockRequestApply.mockResolvedValue(outcome);
      const result = await handleCompactApply({}, ctx());
      expect(result.success, outcome.kind).toBe(false);
      expect(result.output).toContain("do not retry");
    }
  });

  it("`not_ready` surfaces the actual preparation status for the agent to reason with", async () => {
    mockRequestApply.mockResolvedValue({
      kind: "not_ready",
      preparationId: 1,
      status: "applying",
    });

    const result = await handleCompactApply({}, ctx());

    expect(result.output).toContain("applying");
  });

  it("tolerates a stray argument and missing arguments alike", async () => {
    mockRequestApply.mockResolvedValue({ kind: "queued", preparationId: 1 });

    // Models emit `{}`, `undefined`, and occasionally an invented key. None of
    // those is a reason to refuse a call whose intent is unambiguous.
    for (const args of [undefined, {}, { reason: "context is full" }]) {
      const result = await handleCompactApply(args, ctx());
      expect(result.success).toBe(true);
    }
  });

  it("names no removed tool in any output", async () => {
    for (const o of [
      { kind: "queued", preparationId: 1 },
      { kind: "not_ready", preparationId: 1, status: "failed" },
      { kind: "no_preparation" },
    ]) {
      mockRequestApply.mockResolvedValue(o);
      const result = await handleCompactApply({}, ctx());
      expect(result.output).not.toMatch(/compact_now/);
    }
  });
});
