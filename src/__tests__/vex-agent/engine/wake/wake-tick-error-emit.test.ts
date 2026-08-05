/**
 * Wake executor → bounded engine-error emit.
 *
 * A failed wake tick used to be a log line and a bug report, nothing else: the
 * user's scheduled continuation simply never happened and the window said
 * nothing. This pins that the failure now reaches the error bus, that the
 * exception message never rides along, and that the emit survives a
 * bug-report sink that is unreachable — the push needs no I/O, so losing it to
 * a support-DB outage would be the worst possible ordering.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockHandleClaimed = vi.fn();
vi.mock("../../../../vex-agent/engine/wake/executor/claimed.js", () => ({
  handleClaimed: (...a: unknown[]) => mockHandleClaimed(...a),
}));

const mockEmitBugReportSafe = vi.fn();
vi.mock("../../../../lib/diagnostics/bug-report-sink.js", () => ({
  emitBugReportSafe: (...a: unknown[]) => mockEmitBugReportSafe(...a),
}));
vi.mock("../../../../vex-agent/engine/support/bug-report-registry.js", () => ({
  getBugReportSink: () => null,
}));

const { tick } = await import("../../../../vex-agent/engine/wake/executor/tick.js");
import type { EngineErrorEvent } from "../../../../vex-agent/engine/runtime/error-bus.js";

const { engineErrorBus } = await import(
  "../../../../vex-agent/engine/runtime/error-bus.js"
);

const SESSION = "00000000-0000-4000-8000-00000000000a";
const RUN = "00000000-0000-4000-8000-00000000000b";

function wakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    sessionId: SESSION,
    missionRunId: RUN,
    ...overrides,
  };
}

function deps(claimed: ReadonlyArray<unknown>) {
  return {
    isProviderReady: () => true,
    claimDue: async () => claimed,
    // Session-scoped rows take the non-destructive list; this file drives the
    // mission path, so the list is empty.
    listDueSessionWakes: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function capture(): EngineErrorEvent[] {
  const seen: EngineErrorEvent[] = [];
  engineErrorBus.subscribe((event) => seen.push(event));
  return seen;
}

afterEach(() => {
  engineErrorBus.clear();
  vi.clearAllMocks();
});

describe("wake tick engine-error emit", () => {
  it("emits nothing when the claimed wake is handled", async () => {
    const seen = capture();
    mockHandleClaimed.mockResolvedValue({ kind: "resumed", runId: RUN });

    const results = await tick(new Date(), 10, deps([wakeRow()]));

    expect(results[0]?.outcome).toEqual({ kind: "resumed", runId: RUN });
    expect(seen).toHaveLength(0);
  });

  it("emits a bounded `wake`-scoped event when handling throws", async () => {
    const seen = capture();
    const failure = Object.assign(new Error("provider said no: sk-live-SECRET"), {
      status: 503,
    });
    mockHandleClaimed.mockRejectedValue(failure);

    await tick(new Date(), 10, deps([wakeRow()]));

    expect(seen).toHaveLength(1);
    const event = seen[0]!;
    expect(event.scope).toBe("wake");
    expect(event.sessionId).toBe(SESSION);
    expect(event.missionRunId).toBe(RUN);
    expect(event.statusCode).toBe(503);
    // No free text anywhere in the payload.
    expect(JSON.stringify(event)).not.toContain("provider said no");
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });

  it("carries a null missionRunId for a session-scoped agent continuation", async () => {
    const seen = capture();
    mockHandleClaimed.mockRejectedValue(new Error("boom"));

    await tick(new Date(), 10, deps([wakeRow({ missionRunId: null })]));

    expect(seen[0]?.missionRunId).toBeNull();
  });

  it("emits even when the bug-report sink throws", async () => {
    const seen = capture();
    mockHandleClaimed.mockRejectedValue(new Error("boom"));
    mockEmitBugReportSafe.mockRejectedValue(new Error("support db down"));

    await expect(tick(new Date(), 10, deps([wakeRow()]))).rejects.toThrow(
      "support db down",
    );
    // The push landed BEFORE the sink was ever consulted — that ordering is
    // the point.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.scope).toBe("wake");
  });
});
