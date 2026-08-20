/**
 * Composer Stop — reaches a BACKGROUND slice, and reaches it DURABLY.
 *
 * Two defects are pinned here, both of which left a running agent with no
 * working stop:
 *
 *  1. The Stop control rendered only while a submit was pending. A wake-driven
 *     background slice holds the session lease with no pending submit in this
 *     window, so the user could watch the agent work with no way to interrupt
 *     it anywhere in the UI.
 *  2. Stop called only the request-local `stopTurn()`, which aborts THIS
 *     renderer's in-flight request. That cannot touch a slice this window did
 *     not start — it abandons the client's request rather than stopping the
 *     run. The durable `runtime.requestStop` route queues a `stop_terminal`
 *     the engine actually observes.
 *
 * Both routes fire, deliberately: the local abort stays as the instant path
 * for the foreground case, the durable request makes the stop real.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockStopTurn = vi.fn();
const mockRequestStopMutate = vi.fn();
const mockUseRuntimeState = vi.fn();
let submitPending = false;

vi.mock("../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({
    isPending: submitPending,
    mutateAsync: vi.fn(),
    stop: mockStopTurn,
  }),
}));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
  useRequestStop: () => ({ mutateAsync: mockRequestStopMutate }),
}));

const { useComposerSubmit } = await import("../composer-submit.js");
const { ComposerSendControl } = await import("../ComposerSendControl.js");

const SESSION = "00000000-0000-4000-8000-000000000001";

/**
 * The runtime DTO shape the composer reads. `stoppable` is THE signal —
 * `leaseActive` is carried only so the fixture stays a realistic DTO, and the
 * composer must never key on it (it is false across every `loop_defer` park).
 */
function runtimeState(leaseActive: boolean, stoppable = leaseActive) {
  return {
    data: {
      ok: true,
      data: { sessionId: SESSION, status: null, leaseActive, stoppable },
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderComposerSubmit(sessionId: string | null = SESSION) {
  return renderHook(() => useComposerSubmit(sessionId, null, false, null), {
    wrapper,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  submitPending = false;
  mockRequestStopMutate.mockResolvedValue({ ok: true, data: { outcome: "queued" } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("stop availability", () => {
  it("offers Stop for a background slice with no pending submit", () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(true));

    const { result } = renderComposerSubmit();

    expect(result.current.submitPending).toBe(false);
    expect(result.current.stopAvailable).toBe(true);
  });

  it("offers no Stop when the session is idle", () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(false));

    const { result } = renderComposerSubmit();

    expect(result.current.stopAvailable).toBe(false);
  });

  /**
   * POSTURE REVERSAL, deliberate (owner decision A7). This case previously
   * pinned "an unreadable runtime state is not-live", i.e. an errored read hid
   * the Stop key. That is the wrong way to fail on a safety control: the two
   * outcomes are not symmetric. Showing Stop on an idle session costs a key the
   * user does not need and a truthful `no_active_run`; hiding it on a live one
   * leaves an autonomous agent spending real funds with no way to interrupt it.
   *
   * UNKNOWN is now explicit and fails toward SHOWING Stop. A stop that cannot
   * be applied surfaces its own failure notice rather than lying, and the state
   * clears on the next successful `stoppable:false`.
   */
  it("treats an unreadable runtime state as UNKNOWN and still offers Stop", () => {
    mockUseRuntimeState.mockReturnValue({ data: { ok: false, error: {} } });

    const { result } = renderComposerSubmit();

    expect(result.current.stopAvailable).toBe(true);
  });

  /**
   * A TRANSPORT error is unknown too — the failure may be the IPC hop rather
   * than the Result envelope, and neither tells us the agent stopped.
   */
  it("treats an errored query as UNKNOWN and still offers Stop", () => {
    mockUseRuntimeState.mockReturnValue({ data: undefined, isError: true });

    const { result } = renderComposerSubmit();

    expect(result.current.stopAvailable).toBe(true);
  });

  /**
   * NOT-ASKED-YET is NOT unknown, and this is a deliberate narrowing of
   * PLAN v3 §2.6 (see `readStopAvailability`). Reading the first, still-in-
   * flight paint as unknown would put Stop where Send belongs on EVERY session
   * open — a guaranteed wrong affordance on the most common interaction — to
   * cover a renderer that mounted inside a live slice.
   *
   * That case is covered by the push spine instead: a session-lease ACQUIRE now
   * publishes a control-state event, which invalidates this query and refetches
   * within milliseconds. An errored read has no such correction, which is why
   * it — and only it — fails open.
   */
  it("shows SEND on the first paint, before any read has landed", () => {
    mockUseRuntimeState.mockReturnValue({ data: undefined, isError: false });

    const { result } = renderComposerSubmit();

    expect(result.current.stopAvailable).toBe(false);
  });

  /**
   * NO SESSION is a KNOWN negative, never an unknown — and this is the case
   * that makes the distinction load-bearing rather than pedantic.
   *
   * The welcome composer runs with `sessionId === null`, which DISABLES the
   * runtime query, so its data stays `undefined` forever. Read as "unknown",
   * that turned Send into a permanent Stop button and the user could never
   * send a first message. "Unknown" means we asked and got no answer; a
   * session that does not exist yet is not an unanswered question.
   */
  it("offers SEND, not Stop, when there is no session yet (welcome composer)", () => {
    mockUseRuntimeState.mockReturnValue({ data: undefined });

    const { result } = renderComposerSubmit(null);

    expect(result.current.stopAvailable).toBe(false);
  });

  /**
   * The reported defect, at the predicate: a `loop_defer` park has NO lease and
   * NO pending submit. Keyed on the lease this was a hidden key over a running
   * agent; keyed on `stoppable` it is a visible one.
   */
  it("offers Stop while parked on a loop_defer - stoppable without a lease", () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(false, true));

    const { result } = renderComposerSubmit();

    expect(result.current.submitPending).toBe(false);
    expect(result.current.stopAvailable).toBe(true);
  });

  /**
   * A KNOWN negative is the only thing that hides the key — including when a
   * lease is somehow still reported. `stoppable` is the authority; the renderer
   * does not second-guess it from the parts.
   */
  it("hides Stop only on a KNOWN negative", () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(true, false));

    const { result } = renderComposerSubmit();

    expect(result.current.stopAvailable).toBe(false);
  });
});

describe("stop routing - one route per case, never both", () => {
  /**
   * The stranded-row defect. A foreground turn is observed only through the
   * request-local AbortSignal, so a durable `stop_terminal` row queued here
   * has no consumer on this path: it outlives the turn and is later applied
   * to an unrelated approval resume or continuation — stopping work the user
   * never asked to stop.
   */
  it("FOREGROUND: aborts locally and queues NO durable stop row", async () => {
    submitPending = true;
    mockUseRuntimeState.mockReturnValue(runtimeState(true));
    const { result } = renderComposerSubmit();

    await act(async () => {
      result.current.onStop();
    });

    expect(mockStopTurn).toHaveBeenCalledTimes(1);
    expect(mockRequestStopMutate).not.toHaveBeenCalled();
  });

  it("FOREGROUND: a later approval/continuation is unaffected - no row to strand", async () => {
    submitPending = true;
    mockUseRuntimeState.mockReturnValue(runtimeState(true));
    const { result } = renderComposerSubmit();

    await act(async () => {
      result.current.onStop();
    });

    // Zero open session-stop rows were ever requested, so nothing exists to be
    // consumed by the next approval resume or continuation.
    expect(mockRequestStopMutate).toHaveBeenCalledTimes(0);
    expect(result.current.stopRequested).toBe(true);
  });

  it("BACKGROUND: uses the durable route only - stopTurn has nothing to cancel", async () => {
    submitPending = false;
    mockUseRuntimeState.mockReturnValue(runtimeState(true));
    const { result } = renderComposerSubmit();

    await act(async () => {
      result.current.onStop();
    });

    expect(mockRequestStopMutate).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(mockStopTurn).not.toHaveBeenCalled();
    expect(result.current.stopRequested).toBe(true);
  });
});

describe("a durable stop that did not land must not read as success", () => {
  it("restores an actionable Stop on an application-level {ok:false}", async () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(true));
    mockRequestStopMutate.mockResolvedValue({
      ok: false,
      error: { code: "control_failed", message: "internal" },
    });
    const { result } = renderComposerSubmit();

    await act(async () => {
      result.current.onStop();
    });

    // NOT stuck on the disabled "Stopping…" key while the agent runs on.
    expect(result.current.stopRequested).toBe(false);
    expect(result.current.notice?.tone).toBe("error");
    expect(result.current.notice?.text).toMatch(/still going/i);
  });

  it("restores an actionable Stop on a transport rejection", async () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(true));
    mockRequestStopMutate.mockRejectedValue(new Error("ipc down"));
    const { result } = renderComposerSubmit();

    await act(async () => {
      result.current.onStop();
    });

    expect(result.current.stopRequested).toBe(false);
    expect(result.current.notice?.tone).toBe("error");
  });

  it("keeps the acknowledgment when the stop DID land", async () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(true));
    const { result } = renderComposerSubmit();

    await act(async () => {
      result.current.onStop();
    });

    expect(result.current.stopRequested).toBe(true);
    expect(result.current.notice).toBeNull();
  });

  it("surfaces no provider or IPC text in the failure copy", async () => {
    mockUseRuntimeState.mockReturnValue(runtimeState(true));
    mockRequestStopMutate.mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:5777 sk-live-SECRET"),
    );
    const { result } = renderComposerSubmit();

    await act(async () => {
      result.current.onStop();
    });

    expect(result.current.notice?.text).not.toMatch(/ECONNREFUSED|SECRET|5777/);
  });
});

describe("ComposerSendControl", () => {
  function renderControl(props: Record<string, unknown>) {
    return render(
      createElement(ComposerSendControl, {
        reasoningCapability: null,
        reasoningStageIsAgent: false,
        effectiveReasoningEffort: null,
        modelsResolved: true,
        globalModelId: null,
        onReasoningPick: vi.fn(),
        stopAvailable: false,
        stopRequested: false,
        onStop: vi.fn(),
        submitDisabled: false,
        ...props,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any) as ReactNode,
    );
  }

  it("renders the Stop key whenever a slice is live", () => {
    renderControl({ stopAvailable: true });
    expect(screen.getByRole("button", { name: /stop/i })).not.toBeNull();
  });

  it("renders Send when nothing is running", () => {
    renderControl({ stopAvailable: false });
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });

  it("clicking Stop calls the handler", () => {
    const onStop = vi.fn();
    renderControl({ stopAvailable: true, onStop });

    fireEvent.click(screen.getByRole("button", { name: /stop/i }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows the disabled Stopping acknowledgment once requested", () => {
    renderControl({ stopAvailable: true, stopRequested: true });
    const key = screen.getByRole("button", { name: /stopping/i });
    expect((key as HTMLButtonElement).disabled).toBe(true);
  });
});
