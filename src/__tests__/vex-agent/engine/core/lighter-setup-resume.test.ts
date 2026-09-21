import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  intent: null as Record<string, unknown> | null,
  committed: [] as Array<Record<string, unknown>>,
  stamp: vi.fn(),
  consumed: vi.fn(),
  runTurn: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-setup-interactions.js", () => ({
  getById: vi.fn(async () => mocks.intent),
  stampResultMessageWith: (...args: unknown[]) => mocks.stamp(...args),
  markResumeConsumedWith: (...args: unknown[]) => mocks.consumed(...args),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: vi.fn(async () => ({
    outcome: "claimed",
    lease: { sessionId: "session-1" },
  })),
}));
vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (input: unknown) => input,
}));
vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...args: unknown[]) => mocks.release(...args),
}));
vi.mock("@vex-agent/engine/core/runner/gated-session-turn.js", () => ({
  runStopGatedSessionTurn: (...args: unknown[]) => mocks.runTurn(...args),
}));
vi.mock("@vex-agent/engine/core/user-form-runtime.js", () => ({
  commitUserFormToolResult: async (input: Record<string, unknown>) => {
    mocks.committed.push(input);
    await (input.stamp as (client: unknown, id: number) => Promise<void>)({}, 42);
  },
  closeUserFormContinuation: async (input: {
    consume: (client: unknown) => Promise<void>;
  }) => input.consume({}),
}));

const { resumeAgentAfterLighterSetup } = await import(
  "@vex-agent/engine/core/lighter-setup-resume.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.committed.length = 0;
  mocks.intent = {
    intentId: "11111111-1111-4111-8111-111111111111",
    sessionId: "session-1",
    toolCallId: "call_setup",
    environment: "core",
    status: "completed",
    resultMessageId: null,
    resumeConsumedAt: null,
  };
  mocks.stamp.mockResolvedValue(true);
  mocks.consumed.mockResolvedValue(true);
  mocks.runTurn.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
});

describe("resumeAgentAfterLighterSetup", () => {
  it("answers the original call and resumes the same session", async () => {
    const result = await resumeAgentAfterLighterSetup({
      intentId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
    });
    expect(result).toEqual({ resumed: true });
    expect(mocks.committed).toHaveLength(1);
    expect(mocks.committed[0]).toMatchObject({
      success: true,
      ref: { sessionId: "session-1", missionRunId: null, toolCallId: "call_setup" },
    });
    const output = String(mocks.committed[0]?.output);
    // The resumed turn is told to ANSWER, not to go and look things up: a
    // finished setup is not a research prompt (see `setup-presentation.ts`).
    expect(output).toContain("ANSWER NOW and CALL NO FURTHER TOOL");
    expect(output).toContain("Your Lighter Core account is ready.");
    expect(output).toContain("Do not read balances, list markets");
    // A compound request still gets to place the trade it asked for.
    expect(output).toContain("ONLY IF the request did name a specific trade");
    expect(output).toContain("never consent to trade");
    expect(mocks.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      logScope: "lighter_setup_resume",
    }));
    expect(mocks.consumed).toHaveBeenCalledOnce();
  });

  it("tells the model to stop the original trade after deliberate cancellation", async () => {
    mocks.intent = { ...mocks.intent, status: "cancelled" };
    await resumeAgentAfterLighterSetup({
      intentId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
    });
    expect(mocks.committed[0]).toMatchObject({ success: false });
    expect(String(mocks.committed[0]?.output)).toContain(
      "Do not continue any Lighter trade",
    );
  });

  it("does not append or dispatch after the continuation was consumed", async () => {
    mocks.intent = { ...mocks.intent, resumeConsumedAt: "2026-09-20T13:01:00.000Z" };
    const result = await resumeAgentAfterLighterSetup({
      intentId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
    });
    expect(result).toEqual({ resumed: false, reason: "already_resolved" });
    expect(mocks.committed).toHaveLength(0);
    expect(mocks.runTurn).not.toHaveBeenCalled();
  });
});
