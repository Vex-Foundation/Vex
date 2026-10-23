/**
 * `useVexPresence` over the real stores and mocked reads: the wiring from the
 * stores to the pure model. The precedence and the copy are pinned in the pure
 * suites; this one pins that the right store signal reaches the right input.
 */

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import type { ApprovalPendingGlobalDto, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { DONE_HOLD_MS } from "../vex-state.js";
import { approval, session, testId } from "./fixtures.js";

const mocks = vi.hoisted(() => ({
  submitting: false,
  sessionItem: null as SessionListItem | null,
  sessions: [] as SessionListItem[],
  pending: [] as ApprovalSummaryDto[],
  pendingAll: [] as ApprovalPendingGlobalDto[],
  runtime: undefined as RuntimeStateDto | undefined,
  messages: [] as SessionMessageDto[],
}));

vi.mock("../../../lib/api/chat.js", () => ({
  useIsChatSubmitting: (sessionId: string | null) => sessionId !== null && mocks.submitting,
}));
vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => ({ data: { ok: true, data: mocks.pending } }),
  usePendingApprovalsAll: () => ({
    data: { ok: true, data: mocks.pendingAll },
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve(),
  }),
}));
// Signed out: the withdrawal check claims nothing and blocks nothing here.
// One stable answer, as the query cache keeps its data's identity between renders.
const SIGNED_OUT = { ok: true, data: { state: "signed_out" } } as const;
vi.mock("../../../lib/api/vex-cloud.js", () => ({
  useVexCloudWithdrawalNotices: () => ({
    data: SIGNED_OUT,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({
    data: mocks.runtime === undefined ? undefined : { ok: true, data: mocks.runtime },
  }),
}));
vi.mock("../../../lib/api/sessions.js", () => ({
  useSession: () => ({ data: { ok: true, data: mocks.sessionItem } }),
  useSessionsList: () => ({ data: { ok: true, data: mocks.sessions } }),
}));
vi.mock("../../../lib/api/messages.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/api/messages.js")>();
  return {
    ...original,
    useTranscriptInfinite: (sessionId: string | null) => ({
      data:
        sessionId === null
          ? undefined
          : { pages: [{ ok: true, data: { items: mocks.messages, nextCursor: null, hasMore: false } }] },
    }),
  };
});

const { useVexPresence, useDoneEdge } = await import("../useVexPresence.js");
const { useStreamStore } = await import("../../../stores/streamStore.js");
const { useUiStore } = await import("../../../stores/uiStore.js");
const { useEngineErrorStore } = await import("../../../stores/engineErrorStore.js");

const SESSION_ID = testId();

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function present(options?: { waking?: boolean; locked?: boolean }) {
  return renderHook(() => useVexPresence(options), { wrapper });
}

function preview(overrides: Partial<StreamPreview> = {}): StreamPreview {
  return {
    streamId: "stream-1",
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningSegments: [],
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: 1_000,
    status: "working",
    errorType: null,
    errorDetail: null,
    ...overrides,
  };
}

function engineEvent(overrides: Partial<EngineErrorEvent> = {}): EngineErrorEvent {
  return {
    type: "engine.runtime.error",
    sessionId: SESSION_ID,
    missionRunId: null,
    scope: "turn",
    category: "account",
    errorType: null,
    errorClass: null,
    statusCode: null,
    causeCode: null,
    retryAfterSeconds: null,
    occurredAt: "2026-10-17T12:00:00.000Z",
    correlationId: null,
    detail: null,
    remedy: null,
    ...overrides,
  };
}

function runtimeState(overrides: Partial<RuntimeStateDto> = {}): RuntimeStateDto {
  return {
    sessionId: SESSION_ID,
    hasActiveRun: false,
    missionRunId: null,
    status: null,
    stopReason: null,
    lastCheckpointAt: null,
    startedAt: null,
    iterationCount: null,
    leaseActive: false,
    leaseExpiresAt: null,
    pendingControlKind: null,
    stoppable: false,
    activity: { kind: "none" },
    ...overrides,
  };
}

function openSession(mode: "agent" | "mission" = "agent"): void {
  mocks.sessionItem = session({ id: SESSION_ID, mode });
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: SESSION_ID });
}

beforeEach(() => {
  mocks.submitting = false;
  mocks.sessionItem = null;
  mocks.sessions = [];
  mocks.pending = [];
  mocks.pendingAll = [];
  mocks.runtime = undefined;
  mocks.messages = [];
  useStreamStore.setState({ bySessionId: {}, leaseBySessionId: {} });
  useEngineErrorStore.setState({ bySessionId: {} });
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the welcome", () => {
  it("is Ready with no scope, and names a mission that runs in the background", () => {
    mocks.sessions = [session({ title: "Weekly rebalance", missionStatus: "running" })];
    const { result } = present();
    expect(result.current.state).toBe("ready");
    expect(result.current.word).toBe("Ready");
    expect(result.current.fill).toBe("idle");
    expect(result.current.scope).toBeNull();
    expect(result.current.narration).toBeNull();
    expect(result.current.background.summary).toBe("1 mission running · Weekly rebalance");
  });

  it("waits for approval when any approval is pending anywhere", () => {
    mocks.pendingAll = [approval(), approval(), approval()];
    const { result } = present();
    expect(result.current.state).toBe("awaiting");
    expect(result.current.word).toBe("Waiting for approval");
    expect(result.current.narration).toBe(
      "Three decisions wait for you. Nothing signs until you confirm.",
    );
    expect(result.current.needsYou.count).toBe(3);
  });
});

describe("an open chat", () => {
  it("is scoped to the chat and to the mission for a mission session", () => {
    openSession("agent");
    expect(present().result.current.scope).toBe("This chat:");
    cleanup();
    openSession("mission");
    expect(present().result.current.scope).toBe("This mission:");
  });

  it("does not wait on a desk row: the desk's own dialog decides it", () => {
    openSession();
    mocks.pending = [{ ...approval(), sessionId: SESSION_ID, origin: "desk" }];
    const { result } = present();
    expect(result.current.state).not.toBe("awaiting");
  });

  it("waits for approval on the chat's own pending approvals, not another chat's", () => {
    openSession();
    mocks.pendingAll = [approval({ sessionId: testId() })];
    expect(present().result.current.state).toBe("ready");
    cleanup();
    mocks.pending = [
      {
        ...approval(),
        sessionId: SESSION_ID,
      },
    ];
    const { result } = present();
    expect(result.current.state).toBe("awaiting");
    expect(result.current.narration).toBe(
      "One decision waits for you. Nothing signs until you confirm.",
    );
  });

  it("is Working with the tool named, the question quoted and the timer started", () => {
    openSession();
    mocks.submitting = true;
    mocks.messages = [
      {
        id: 1,
        sessionId: SESSION_ID,
        role: "user",
        kind: "text",
        content: "What is my ETH balance?",
        createdAt: "2026-10-17T12:00:00.000Z",
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        explorerRefs: null,
        reasoning: null,
        durationMs: null,
        success: null,
        displayStatus: null,
        board: null,
        interruptDisposition: null,
      },
    ];
    useStreamStore.setState({
      bySessionId: {
        [SESSION_ID]: preview({ status: "calling", toolName: "wallet_balances", startedAtMs: 5_000 }),
      },
    });
    const { result } = present();
    expect(result.current.state).toBe("working");
    expect(result.current.word).toBe("Working");
    expect(result.current.timerStartedAt).toBe(5_000);
    // The turn island speaks a live turn, so the state word's announcer stays quiet.
    expect(result.current.live).toBe(true);
    expect(result.current.narration).toBe(
      "Calling Wallet balances to answer “What is my ETH balance?”",
    );
  });

  it("is Thinking while the model has the turn", () => {
    openSession();
    mocks.submitting = true;
    useStreamStore.setState({ bySessionId: { [SESSION_ID]: preview({ status: "working" }) } });
    expect(present().result.current.state).toBe("thinking");
  });

  it("is Error for a failed turn and Concerned for a rate-limited provider", () => {
    openSession();
    useEngineErrorStore.setState({ bySessionId: { [SESSION_ID]: engineEvent() } });
    const failed = present().result.current;
    expect(failed.state).toBe("error");
    expect(failed.narration).toBe("This turn failed");
    cleanup();
    useEngineErrorStore.setState({
      bySessionId: {
        [SESSION_ID]: engineEvent({ category: "capacity", retryAfterSeconds: 41 }),
      },
    });
    const limited = present().result.current;
    expect(limited.state).toBe("concerned");
    expect(limited.narration).toBe("Provider rate-limited or unavailable. Retry in 41s.");
  });

  it("is Concerned while the machine is offline", () => {
    openSession();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result } = present();
    expect(result.current.state).toBe("concerned");
    expect(result.current.narration).toBe("Offline: waiting for the network to come back.");
  });

  it("is Error for a mission paused on an error and Sleeping for one parked on a wake", () => {
    openSession("mission");
    mocks.runtime = runtimeState({ hasActiveRun: true, status: "paused_error" });
    expect(present().result.current.state).toBe("error");
    cleanup();
    mocks.runtime = runtimeState({
      hasActiveRun: true,
      status: "paused_wake",
      pausedWake: { dueAt: "2026-10-17T13:37:00.000Z", reason: null, watchSummary: null },
    });
    const { result } = present();
    expect(result.current.state).toBe("sleeping");
    expect(result.current.narration).toMatch(/^Vex went to sleep\. Wakes at .+\.$/);
  });

  it("is Working for a running mission between turns, with no timer", () => {
    openSession("mission");
    mocks.runtime = runtimeState({ hasActiveRun: true, status: "running", leaseActive: true });
    const { result } = present();
    expect(result.current.state).toBe("working");
    expect(result.current.timerStartedAt).toBeNull();
    // No turn is live: the announcer is the one that says it.
    expect(result.current.live).toBe(false);
  });

  it("lists a mission that needs a decision under Needs you, and keeps Ready", () => {
    openSession("agent");
    mocks.sessions = [session({ missionStatus: "paused_plan_acceptance" })];
    const { result } = present();
    expect(result.current.state).toBe("ready");
    expect(result.current.needsYou.count).toBe(1);
    expect(result.current.needsYou.items.map((item) => item.title)).toEqual(["Accept the contract"]);
  });
});

describe("Studio and the plates", () => {
  it("reads no chat in Studio: the project scope, whatever session lingers", () => {
    openSession();
    useUiStore.setState({ runtimeMode: "studio" });
    mocks.submitting = true;
    useStreamStore.setState({ bySessionId: { [SESSION_ID]: preview() } });
    const { result } = present();
    expect(result.current.scope).toBe("This project:");
    expect(result.current.state).toBe("ready");
  });

  it("is Sleeping and worded Locked on the lock plate, Waking up on the boot plate", () => {
    const locked = present({ locked: true }).result.current;
    expect(locked.state).toBe("sleeping");
    expect(locked.word).toBe("Sleeping · Locked");
    cleanup();
    expect(present({ waking: true }).result.current.word).toBe("Waking up");
  });
});

describe("useDoneEdge", () => {
  it("holds Done for the hold time after a clean live to settled edge, then releases it", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ live, blocked }: { live: boolean; blocked: boolean }) =>
        useDoneEdge("session-a", live, blocked),
      { initialProps: { live: true, blocked: false } },
    );
    expect(result.current).toBe(false);
    rerender({ live: false, blocked: false });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DONE_HOLD_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("does not fire for a turn that stopped on an approval or a failure", () => {
    const { result, rerender } = renderHook(
      ({ live, blocked }: { live: boolean; blocked: boolean }) =>
        useDoneEdge("session-a", live, blocked),
      { initialProps: { live: true, blocked: false } },
    );
    rerender({ live: false, blocked: true });
    expect(result.current).toBe(false);
  });

  it("a new live turn clears it, and another session never inherits it", () => {
    const { result, rerender } = renderHook(
      ({ id, live }: { id: string; live: boolean }) => useDoneEdge(id, live, false),
      { initialProps: { id: "session-a", live: true } },
    );
    rerender({ id: "session-a", live: false });
    expect(result.current).toBe(true);
    rerender({ id: "session-b", live: false });
    expect(result.current).toBe(false);
    rerender({ id: "session-b", live: true });
    rerender({ id: "session-b", live: false });
    expect(result.current).toBe(true);
    rerender({ id: "session-b", live: true });
    expect(result.current).toBe(false);
  });

  it("never fires with no session", () => {
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useDoneEdge(null, live, false),
      { initialProps: { live: true } },
    );
    rerender({ live: false });
    expect(result.current).toBe(false);
  });
});
