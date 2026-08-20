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

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovalsAll: (opts?: { readonly refetchInterval?: number }) => {
    refetchIntervals.push(opts?.refetchInterval);
    return pendingState;
  },
  useGlobalApprovalsLiveSync: () => {},
  useApprove: () => ({ mutate: mockApproveMutate, isPending: false }),
  useReject: () => ({ mutate: mockRejectMutate, isPending: false }),
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
  pendingState = { data: undefined };
  // A full-app screen is open, so "Open session" must also close it.
  useUiStore.setState({
    activeSessionId: null,
    shellRoute: { kind: "memory", origin: null },
  });
});

afterEach(() => {
  useUiStore.setState({ activeSessionId: null, shellRoute: { kind: "none" } });
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
