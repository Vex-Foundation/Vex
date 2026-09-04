/**
 * GlobalApprovals tests — the DESK RULE app-wide pending-approvals inbox.
 *
 * Pins:
 *   - badge hidden while loading, when empty, and when the query errors (A4);
 *   - badge count + panel lists items across sessions with their titles;
 *   - session-less row → "Background approval" fallback, no "Open session";
 *   - "Open session" navigates the UI store and closes the panel;
 *   - approve on a rendered `ApprovalCard` fires the mutation with `{ id }`
 *     (the full risk-gated card is reused verbatim);
 *   - Escape + outside pointerdown close; Escape restores trigger focus (A6);
 *   - two-tier FALLBACK poll cadence 60s idle / 15s open — slowed from
 *     15s/5s once `useMissionUpdateLiveSync` began invalidating `pendingAll`
 *     on `approval_enqueued`, so the badge is push-driven and the poll is the
 *     dropped-event net (still two-tier: an open panel is a live list);
 *   - a count over 99 collapses to "99+" (A6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";

const mockApproveMutate = vi.fn();
const mockRejectMutate = vi.fn();
const refetchIntervals: Array<number | undefined> = [];
let pendingState: {
  data: Result<ReadonlyArray<ApprovalPendingGlobalDto>> | undefined;
} = { data: undefined };

/**
 * A decision already in flight, which is what DISABLES a card's Reject. It is a
 * mutable flag because the open-focus rule below has two arms and the second
 * one exists only while a card names nothing focusable.
 */
let decisionInFlight = false;

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovalsAll: (opts?: { readonly refetchInterval?: number }) => {
    refetchIntervals.push(opts?.refetchInterval);
    return pendingState;
  },
  useGlobalApprovalsLiveSync: () => {},
  useApprove: () => ({ mutate: mockApproveMutate, isPending: decisionInFlight }),
  useReject: () => ({ mutate: mockRejectMutate, isPending: decisionInFlight }),
}));

const { GlobalApprovals } = await import("../GlobalApprovals.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION_A = "00000000-0000-4000-8000-0000000000a1";
const SESSION_B = "00000000-0000-4000-8000-0000000000b2";

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

function renderBadge(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <GlobalApprovals />
    </QueryClientProvider>,
  );
}

function getBadge(): HTMLElement {
  return screen.getByRole("button", { name: /awaiting your signature/i });
}

function queryBadge(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-vex-area='global-approvals-badge']",
  );
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

describe("GlobalApprovals - badge visibility", () => {
  it("renders nothing while loading (data undefined)", () => {
    pendingState = { data: undefined };
    renderBadge();
    expect(queryBadge()).toBeNull();
  });

  it("renders nothing when there are no pending approvals", () => {
    pendingState = { data: { ok: true, data: [] } };
    renderBadge();
    expect(queryBadge()).toBeNull();
  });

  it("renders nothing when the query errors (A4)", () => {
    pendingState = errorState();
    renderBadge();
    expect(queryBadge()).toBeNull();
  });
});

describe("GlobalApprovals - panel", () => {
  it("shows the count and lists items across sessions with titles", () => {
    pendingState = {
      data: {
        ok: true,
        data: [
          makeRow({
            id: "g-a",
            sessionId: SESSION_A,
            sessionTitle: "Alpha session",
            createdAt: "2026-05-28T10:00:00.000Z",
          }),
          makeRow({
            id: "g-b",
            sessionId: SESSION_B,
            sessionTitle: "Beta session",
            createdAt: "2026-05-28T10:05:00.000Z",
          }),
        ],
      },
    };
    renderBadge();
    const badge = getBadge();
    expect(badge.textContent).toContain("AWAITING 2");
    fireEvent.click(badge);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Alpha session")).toBeTruthy();
    expect(screen.getByText("Beta session")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /open session/i }),
    ).toHaveLength(2);
  });

  it("session-less row → 'Background approval' fallback, no Open session", () => {
    pendingState = {
      data: {
        ok: true,
        data: [makeRow({ id: "g-x", sessionId: null, sessionTitle: null })],
      },
    };
    renderBadge();
    fireEvent.click(getBadge());
    expect(screen.getByText("Background approval")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /open session/i }),
    ).toBeNull();
  });

  it("Open session navigates the UI store and closes the panel", () => {
    pendingState = {
      data: {
        ok: true,
        data: [
          makeRow({
            id: "g-a",
            sessionId: SESSION_A,
            sessionTitle: "Alpha session",
          }),
        ],
      },
    };
    renderBadge();
    fireEvent.click(getBadge());
    fireEvent.click(screen.getByRole("button", { name: /open session/i }));
    expect(useUiStore.getState().activeSessionId).toBe(SESSION_A);
    // Any covering full-app screen closes so the jump lands on the transcript.
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Open session from STUDIO switches to the agent shell with the selection", () => {
    // The strip is mounted above the mode dispatch, so this panel is reachable
    // from Studio - and a session transcript only exists in the agent shell.
    // Selecting the session without switching the mode leaves the user in
    // Studio, looking at a project workspace, having pressed a control that
    // promised them a session.
    useUiStore.setState({ runtimeMode: "studio" });
    pendingState = {
      data: {
        ok: true,
        data: [
          makeRow({
            id: "g-a",
            sessionId: SESSION_A,
            sessionTitle: "Alpha session",
          }),
        ],
      },
    };
    renderBadge();
    fireEvent.click(getBadge());
    fireEvent.click(screen.getByRole("button", { name: /open session/i }));

    // ONE navigation: the mode and the selection land together, not one
    // without the other.
    const state = useUiStore.getState();
    expect(state.runtimeMode).toBe("agent");
    expect(state.activeSessionId).toBe(SESSION_A);
    expect(state.shellRoute).toEqual({ kind: "none" });
  });

  it("approve on a rendered card fires the mutation with the approval id", () => {
    pendingState = {
      data: {
        ok: true,
        data: [makeRow({ id: "g-a", riskLevel: "info", actionKind: "read" })],
      },
    };
    renderBadge();
    fireEvent.click(getBadge());
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "g-a" },
      expect.any(Object),
    );
  });

  it("reject on a rendered card fires the mutation with the approval id", () => {
    pendingState = {
      data: {
        ok: true,
        data: [makeRow({ id: "g-a", riskLevel: "info", actionKind: "read" })],
      },
    };
    renderBadge();
    fireEvent.click(getBadge());
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(mockRejectMutate).toHaveBeenCalledWith(
      { id: "g-a" },
      expect.any(Object),
    );
  });
});

describe("GlobalApprovals - dismissal + focus (A6)", () => {
  it("Escape closes the panel and restores focus to the trigger", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderBadge();
    const badge = getBadge();
    fireEvent.click(badge);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it("an outside pointerdown closes the panel", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderBadge();
    fireEvent.click(getBadge());
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("GlobalApprovals - poll cadence + overflow", () => {
  it("falls back at 60s idle and 15s while the panel is open", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    renderBadge();
    expect(refetchIntervals.at(-1)).toBe(60_000);
    fireEvent.click(getBadge());
    expect(refetchIntervals.at(-1)).toBe(15_000);
  });

  it("collapses a count over 99 to '99+' (A6)", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeRow({
        id: `g-${i}`,
        createdAt: `2026-05-28T10:00:00.${String(i).padStart(3, "0")}Z`,
      }),
    );
    pendingState = { data: { ok: true, data: rows } };
    renderBadge();
    expect(getBadge().textContent).toContain("AWAITING 99+");
  });
});

/**
 * THE INBOX ORDER AND WHERE THE PANEL PUTS THE KEYBOARD, both measured defects
 * on a real Studio approval card (live test pass 2, I-2): the panel moved focus
 * to its own container, so a reader who opened it with the keyboard was on
 * nothing, one Tab from a free-text reason field and two from a decision.
 *
 * Rule 08: default focus for a dangerous action goes to the SAFER choice. The
 * safer choice here is Reject, and it is the row a user just caused that they
 * came for, so the two rules meet on one element - the newest card's Reject.
 */
describe("GlobalApprovals - inbox order and the keyboard's landing", () => {
  const OLDEST = "2026-05-28T10:00:00.000Z";
  const NEWEST = "2026-05-28T10:05:00.000Z";

  function twoRows(): void {
    pendingState = {
      data: {
        ok: true,
        data: [
          makeRow({
            id: "g-old",
            sessionId: SESSION_A,
            sessionTitle: "Older session",
            createdAt: OLDEST,
          }),
          makeRow({
            id: "g-new",
            sessionId: SESSION_B,
            sessionTitle: "Newer session",
            createdAt: NEWEST,
          }),
        ],
      },
    };
  }

  it("lists the newest approval first", () => {
    twoRows();
    renderBadge();
    fireEvent.click(getBadge());
    const titles = Array.from(
      screen
        .getByRole("dialog")
        .querySelectorAll("[data-vex-area='global-approval-item']"),
    ).map((item) => item.textContent ?? "");
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain("Newer session");
    expect(titles[1]).toContain("Older session");
  });

  it("puts initial focus on the newest card's Reject, not on the panel", () => {
    twoRows();
    renderBadge();
    fireEvent.click(getBadge());
    const panel = screen.getByRole("dialog");
    const rejects = screen.getAllByRole("button", { name: "Reject" });
    expect(document.activeElement).toBe(rejects[0]);
    expect(document.activeElement).not.toBe(panel);
    // The focused Reject really is the newest row's, not merely the first
    // Reject of an arbitrary order.
    const items = Array.from(
      panel.querySelectorAll("[data-vex-area='global-approval-item']"),
    );
    expect(items[0]?.contains(document.activeElement)).toBe(true);
    expect(items[0]?.textContent ?? "").toContain("Newer session");
  });

  it("falls back to the panel when the newest card names nothing focusable", () => {
    decisionInFlight = true;
    twoRows();
    renderBadge();
    fireEvent.click(getBadge());
    const panel = screen.getByRole("dialog");
    expect(
      screen.getAllByRole("button", { name: "Reject" })[0]?.hasAttribute("disabled"),
    ).toBe(true);
    expect(document.activeElement).toBe(panel);
  });

  /**
   * Reject NAMES itself the initial focus with the same `autofocus` content
   * attribute every dialog in this app uses, so a card inside the panel and a
   * card inside a dialog resolve to the same element by ONE rule. If that name
   * is dropped, the panel silently returns to focusing its container.
   */
  it("resolves the safer action by the named-initial-focus attribute", () => {
    twoRows();
    renderBadge();
    fireEvent.click(getBadge());
    const named = screen
      .getByRole("dialog")
      .querySelector("[autofocus]:not([disabled])");
    expect(named).not.toBeNull();
    expect(named?.getAttribute("aria-label")).toBe("Reject");
  });
});

/**
 * STUDIO MODE, and the honest limit of what this file can prove about it.
 *
 * Measured (live test pass 2, I-2): in Studio the `AWAITING 1` badge appeared
 * to do nothing and the card was reachable only after switching to Agent mode.
 * The React path is mode-agnostic and these tests show it opening, listing and
 * focusing under `runtimeMode: "studio"` exactly as in agent mode, so whatever
 * was observed is NOT a branch in this component.
 *
 * jsdom has no layout engine, so it cannot see paint order, clipping or hit
 * testing, and a test here asserting "the Studio panel opens" would have passed
 * before and after any fix. These cases therefore claim only what jsdom models:
 * the panel mounts its rows in Studio, and the keyboard lands on the safer
 * action rather than on a Studio surface. Settling the visual report needs a
 * Playwright run in Studio with a pending approval.
 */
describe("GlobalApprovals - Studio mode", () => {
  beforeEach(() => {
    useUiStore.setState({ runtimeMode: "studio" });
  });

  it("opens the panel in place with the full card, without leaving Studio", () => {
    pendingState = {
      data: { ok: true, data: [makeRow({ id: "g-studio" })] },
    };
    renderBadge();
    fireEvent.click(getBadge());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    // Opening the inbox is not a navigation: the user is still in Studio.
    expect(useUiStore.getState().runtimeMode).toBe("studio");
  });

  it("lands the keyboard on the safer action, not on a Studio surface", () => {
    pendingState = {
      data: { ok: true, data: [makeRow({ id: "g-studio" })] },
    };
    renderBadge();
    fireEvent.click(getBadge());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reject" }),
    );
  });
});
