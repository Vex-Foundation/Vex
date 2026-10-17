/**
 * GlobalApprovals tests: the app-wide approvals' sync and the review card a
 * Needs you Review key opens (the count and the list are
 * `features/vex/__tests__/NeedsYouControl.test.tsx`).
 *
 * Pins:
 *   - the sync draws nothing and keeps the 60s FALLBACK poll (the list is
 *     push-driven: `useMissionUpdateLiveSync` invalidates `pendingAll` on
 *     `approval_enqueued`); an open review asks for 15s;
 *   - the review reuses the full `ApprovalCard` verbatim: approve and reject
 *     fire their mutation with `{ id }`, a working card locks on the click;
 *   - a session-less row reads "Background approval" with no "Open session";
 *     "Open session" lands on the transcript (from Studio too: the mode, the
 *     selection and the closed page in one navigation) and closes the review;
 *   - Escape and a backdrop click close the review without deciding;
 *   - the keyboard lands on Reject, the safer choice, through the card's named
 *     initial focus, and on the panel when Reject is not focusable;
 *   - in Studio the card opens in place, the user stays in Studio;
 *   - the review closes by itself when its approval is no longer pending or
 *     the next read fails, and stays through a failed refetch that still
 *     holds the row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";

const mockApproveMutate = vi.fn();
const mockRejectMutate = vi.fn();
const refetchIntervals: Array<number | undefined> = [];
let pendingState: {
  data: Result<ReadonlyArray<ApprovalPendingGlobalDto>> | undefined;
  isError?: boolean;
} = { data: undefined };

/** A decision already in flight, which is what DISABLES a card's Reject. */
let decisionInFlight = false;

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovalsAll: (opts?: { readonly refetchInterval?: number }) => {
    refetchIntervals.push(opts?.refetchInterval);
    return { isError: false, ...pendingState };
  },
  useGlobalApprovalsLiveSync: () => {},
  useApprove: () => ({ mutate: mockApproveMutate, isPending: decisionInFlight }),
  useReject: () => ({ mutate: mockRejectMutate, isPending: decisionInFlight }),
}));

const { GlobalApprovalsReview, GlobalApprovalsSync, IDLE_POLL_MS, REVIEW_OPEN_POLL_MS } =
  await import("../GlobalApprovals.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION_A = "00000000-0000-4000-8000-0000000000a1";

function makeRow(
  over: Partial<ApprovalPendingGlobalDto> = {},
): ApprovalPendingGlobalDto {
  return {
    id: "g-1",
    sessionId: SESSION_A,
    toolCallId: "tc-1",
    toolName: "wallet:send",
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-05-28T10:00:00.000Z",
    resolvedAt: null,
    reasoningPreview: "confirm transfer",
    actionKind: "read",
    riskLevel: "info",
    preview: null,
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: null,
    projectId: null,
    requestedByClient: null,
    projectName: null,
    sessionTitle: "Alpha session",
    ...over,
  };
}

function errorState(): {
  data: Result<ReadonlyArray<ApprovalPendingGlobalDto>>;
} {
  return {
    data: {
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "approvals",
        message: "Unable to load approvals.",
        retryable: true,
        userActionable: false,
        redacted: true,
        correlationId: "req-x",
      },
    },
  };
}

function withClient(node: ReactNode): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function renderReview(
  approvalId = "g-1",
  onClose: () => void = () => undefined,
): ReturnType<typeof render> {
  return render(withClient(<GlobalApprovalsReview approvalId={approvalId} onClose={onClose} />));
}

function reviewPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>("[data-vex-area='global-approvals-panel']");
  if (panel === null) throw new Error("review missing");
  return panel;
}

beforeEach(() => {
  mockApproveMutate.mockReset();
  mockRejectMutate.mockReset();
  refetchIntervals.length = 0;
  decisionInFlight = false;
  pendingState = { data: undefined };
  // A full-app screen is open, so "Open session" must also close it.
  useUiStore.setState({
    activeSessionId: null,
    shellRoute: { kind: "memory", origin: null },
    runtimeMode: "agent",
  });
});

afterEach(() => {
  useUiStore.setState({
    activeSessionId: null,
    shellRoute: { kind: "none" },
    runtimeMode: "agent",
  });
});

describe("GlobalApprovalsSync", () => {
  it("draws nothing and keeps the 60s fallback poll", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    const { container } = render(withClient(<GlobalApprovalsSync />));
    expect(container.textContent).toBe("");
    expect(IDLE_POLL_MS).toBe(60_000);
    expect(refetchIntervals.at(-1)).toBe(60_000);
  });

  it("an open review asks for the faster 15s net", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderReview();
    expect(REVIEW_OPEN_POLL_MS).toBe(15_000);
    expect(refetchIntervals.at(-1)).toBe(15_000);
  });
});

describe("GlobalApprovalsReview: the card", () => {
  it("shows the approval's full card under its session", () => {
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-a" })] } };
    renderReview("g-a");
    const panel = reviewPanel();
    expect(panel.querySelector("[data-approval-id='g-a']")).not.toBeNull();
    expect(screen.getByText("Alpha session")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open session/i })).toBeTruthy();
  });

  it("session-less row → 'Background approval' fallback, no Open session", () => {
    pendingState = {
      data: { ok: true, data: [makeRow({ id: "g-x", sessionId: null, sessionTitle: null })] },
    };
    renderReview("g-x");
    expect(screen.getByText("Background approval")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open session/i })).toBeNull();
  });

  it("approve on the card fires the mutation with the approval id", () => {
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-a" })] } };
    renderReview("g-a");
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(mockApproveMutate).toHaveBeenCalledWith({ id: "g-a" }, expect.any(Object));
  });

  it("reject on the card fires the mutation with the approval id", () => {
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-a" })] } };
    renderReview("g-a");
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: "g-a" }, expect.any(Object));
  });

  it("a card says it is working and locks on the click itself", () => {
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-a" })] } };
    renderReview("g-a");
    const approveKey = screen.getByRole("button", { name: /^approve$/i });
    fireEvent.click(approveKey);
    fireEvent.click(approveKey);
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: /working, please wait/i }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /^reject$/i }).getAttribute("disabled")).not.toBeNull();
  });
});

describe("GlobalApprovalsReview: Open session", () => {
  it("navigates the UI store and closes the review", () => {
    const onClose = vi.fn();
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-a" })] } };
    renderReview("g-a", onClose);
    fireEvent.click(screen.getByRole("button", { name: /open session/i }));
    expect(useUiStore.getState().activeSessionId).toBe(SESSION_A);
    // Any covering full-app screen closes so the jump lands on the transcript.
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
    expect(onClose).toHaveBeenCalled();
  });

  it("from STUDIO switches to the agent shell with the selection", () => {
    useUiStore.setState({ runtimeMode: "studio" });
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-a" })] } };
    renderReview("g-a");
    fireEvent.click(screen.getByRole("button", { name: /open session/i }));
    // ONE navigation: the mode and the selection land together.
    const state = useUiStore.getState();
    expect(state.runtimeMode).toBe("agent");
    expect(state.activeSessionId).toBe(SESSION_A);
    expect(state.shellRoute).toEqual({ kind: "none" });
  });
});

describe("GlobalApprovalsReview: dismissal and focus", () => {
  it("Escape closes the review without deciding", () => {
    const onClose = vi.fn();
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderReview("g-1", onClose);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalled();
    expect(mockApproveMutate).not.toHaveBeenCalled();
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });

  it("a backdrop click closes the review without deciding the action", () => {
    const onClose = vi.fn();
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderReview("g-1", onClose);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalled();
    expect(mockApproveMutate).not.toHaveBeenCalled();
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });

  it("puts initial focus on the card's Reject, not on the panel", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderReview();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reject" }));
    expect(document.activeElement).not.toBe(screen.getByRole("dialog"));
  });

  it("falls back to the panel when the card names nothing focusable", () => {
    decisionInFlight = true;
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderReview();
    // The flag marks a rejection in flight too, so the key names that.
    expect(
      screen
        .getByRole("button", { name: /^(Reject|Rejecting, please wait)$/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  /**
   * Reject NAMES itself the initial focus with the same `autofocus` content
   * attribute every dialog in this app uses, so a card inside the review and a
   * card inside any other dialog resolve to the same element by ONE rule.
   */
  it("resolves the safer action by the named-initial-focus attribute", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderReview();
    const named = screen.getByRole("dialog").querySelector("[autofocus]:not([disabled])");
    expect(named).not.toBeNull();
    expect(named?.getAttribute("aria-label")).toBe("Reject");
  });
});

/**
 * STUDIO MODE: the review is mode-agnostic, and jsdom models only that much
 * (no paint order, clipping or hit testing; the real window is the e2e
 * `studio-approvals.spec.ts`).
 */
describe("GlobalApprovalsReview: Studio mode", () => {
  beforeEach(() => {
    useUiStore.setState({ runtimeMode: "studio" });
  });

  it("opens in place with the full card, without leaving Studio", () => {
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-studio" })] } };
    renderReview("g-studio");
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(useUiStore.getState().runtimeMode).toBe("studio");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reject" }));
  });
});

describe("GlobalApprovalsReview: closes itself on stale facts", () => {
  it("closes when its approval is no longer pending", () => {
    const onClose = vi.fn();
    pendingState = { data: { ok: true, data: [makeRow({ id: "g-a" })] } };
    const view = renderReview("g-a", onClose);
    expect(onClose).not.toHaveBeenCalled();
    pendingState = { data: { ok: true, data: [] } };
    view.rerender(withClient(<GlobalApprovalsReview approvalId="g-a" onClose={onClose} />));
    expect(onClose).toHaveBeenCalled();
    expect(document.querySelector("[data-vex-area='global-approvals-panel']")).toBeNull();
  });

  it("closes when the next read fails", () => {
    const onClose = vi.fn();
    pendingState = { data: { ok: true, data: [makeRow()] } };
    const view = renderReview("g-1", onClose);
    pendingState = errorState();
    view.rerender(withClient(<GlobalApprovalsReview approvalId="g-1" onClose={onClose} />));
    expect(onClose).toHaveBeenCalled();
  });

  it("stays through a failed refetch that still holds the row", () => {
    const onClose = vi.fn();
    pendingState = { data: { ok: true, data: [makeRow()] }, isError: true };
    renderReview("g-1", onClose);
    expect(onClose).not.toHaveBeenCalled();
    expect(reviewPanel()).toBeTruthy();
  });
});
