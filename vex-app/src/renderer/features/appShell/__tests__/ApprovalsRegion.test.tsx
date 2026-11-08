/**
 * ApprovalsRegion tests (F3).
 *
 * Pins:
 *   - empty pending list → renders nothing (no chrome to hide composer);
 *   - Result.ok=false → renders inline error (Codex F3 #1);
 *   - one pending row → renders one ApprovalCard with the right id;
 *   - the FIRST newly-appearing card gets `focusOnMount` (Codex F3 #3);
 *   - no veil: nothing dims the session while an approval waits
 *     (docs/design/R3-MINIMAL.md sections 8.1 and 12).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalActionResult, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";

type PendingData =
  | { data: Result<ReadonlyArray<ApprovalSummaryDto>> }
  | { data: undefined };

let pendingState: PendingData = { data: undefined };
/** The approvals read (`approvals.get`) by id, for the closed cards. */
let records = new Map<string, ApprovalSummaryDto | null>();
type MutateOptions = { onSuccess?: (result: Result<ApprovalActionResult>) => void };
let rejectMutate = vi.fn<(input: unknown, options?: MutateOptions) => void>();
const refetch = vi.fn();

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => pendingState,
  useApprove: () => ({ mutate: vi.fn(), isPending: false }),
  useReject: () => ({ mutate: rejectMutate, isPending: false }),
  useApproval: (id: string | null) =>
    id !== null && records.has(id)
      ? { data: { ok: true, data: records.get(id) ?? null }, isError: false, refetch, dataUpdatedAt: 1 }
      : { data: undefined, isError: false, refetch, dataUpdatedAt: 0 },
}));

const { ApprovalsRegion } = await import("../ApprovalsRegion.js");
const { ApprovalDockProvider } = await import("../ApprovalCard/approval-dock.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-00000000aa01";

function makeSummary(
  over: Partial<ApprovalSummaryDto> = {},
): ApprovalSummaryDto {
  return {
    id: "appr-1",
    sessionId: SESSION,
    toolCallId: "call-1",
    toolName: "wallet:send",
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-05-28T10:00:00.000Z",
    resolvedAt: null,
    reasoningPreview: "Send 0.5 ETH.",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: {
      toolName: "send",
      namespace: "wallet",
      criticalArgs: { amount: "0.5" },
    },
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: null,
    projectId: null,
    requestedByClient: null,
    ...over,
  };
}

function renderRegion(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApprovalsRegion sessionId={SESSION} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pendingState = { data: undefined };
  records = new Map();
  rejectMutate = vi.fn();
  refetch.mockClear();
});

describe("ApprovalsRegion", () => {
  it("loading (no data) → renders nothing", () => {
    pendingState = { data: undefined };
    const { container } = renderRegion();
    expect(container.firstChild).toBeNull();
  });

  it("empty rows → renders nothing (no chrome)", () => {
    pendingState = { data: { ok: true, data: [] } };
    const { container } = renderRegion();
    expect(container.firstChild).toBeNull();
  });

  it("Result.ok=false → renders inline alert with message", () => {
    pendingState = {
      data: {
        ok: false,
        error: {
          code: "data.read_failed",
          domain: "approvals",
          message: "DB temporarily unavailable.",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "req-x",
        },
      },
    };
    renderRegion();
    expect(screen.getByRole("alert").textContent).toContain(
      "DB temporarily unavailable.",
    );
  });

  it("one pending row → renders one ApprovalCard with right id + tool", () => {
    pendingState = {
      data: { ok: true, data: [makeSummary({ id: "appr-only" })] },
    };
    renderRegion();
    expect(screen.getByText("Confirm this transfer")).toBeTruthy();
    expect(screen.getByText("wallet:send")).toBeTruthy();
    // data-approval-id reflects the DTO id (used by integration / debug).
    const card = document.querySelector("[data-approval-id='appr-only']");
    expect(card).not.toBeNull();
  });

  it("draws no veil and no mask: the card is the one framed thing on screen", () => {
    pendingState = {
      data: { ok: true, data: [makeSummary({ id: "appr-only" })] },
    };
    const { container } = renderRegion();
    expect(document.querySelector("[data-vex-area='approval-focus-mask']")).toBeNull();
    expect(document.querySelector(".vex-approval-mask")).toBeNull();
    // The region is the card's scroller and nothing else: no layer above it.
    const region = container.querySelector("[data-vex-area='approvals-region']");
    expect(region?.className).not.toMatch(/\bz-\d/);
    expect(region?.children).toHaveLength(1);
  });

  it("leaves a desk click's card to the desk's own dialog", () => {
    pendingState = {
      data: {
        ok: true,
        data: [
          makeSummary({ id: "appr-desk", origin: "desk" }),
          makeSummary({ id: "appr-agent", origin: "agent" }),
        ],
      },
    };
    renderRegion();
    expect(document.querySelector("[data-approval-id='appr-desk']")).toBeNull();
    expect(document.querySelector("[data-approval-id='appr-agent']")).not.toBeNull();
  });

  it("the FIRST newly-appearing (oldest by createdAt) card gets focus on mount", () => {
    pendingState = {
      data: {
        ok: true,
        data: [
          makeSummary({
            id: "appr-newer",
            createdAt: "2026-05-28T10:05:00.000Z",
            riskLevel: "info",
            actionKind: "read",
          }),
          makeSummary({
            id: "appr-older",
            createdAt: "2026-05-28T10:00:00.000Z",
            riskLevel: "info",
            actionKind: "read",
          }),
        ],
      },
    };
    renderRegion();
    const olderCard = document.querySelector(
      "[data-approval-id='appr-older']",
    );
    expect(olderCard).not.toBeNull();
    // The oldest of the new arrivals owns initial focus → its Reject button.
    const olderReject = olderCard?.querySelector("button");
    expect(document.activeElement).toBe(olderReject);
  });

  it("docks ONE decision row in the chat's bottom row: the oldest card's, the one a fresh batch focuses", () => {
    pendingState = {
      data: {
        ok: true,
        data: [
          makeSummary({ id: "appr-newer", createdAt: "2026-05-28T10:05:00.000Z", riskLevel: "info", actionKind: "read" }),
          makeSummary({ id: "appr-older", createdAt: "2026-05-28T10:00:00.000Z", riskLevel: "info", actionKind: "read" }),
        ],
      },
    };
    const dock = document.createElement("div");
    document.body.appendChild(dock);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalDockProvider value={dock}>
          <ApprovalsRegion sessionId={SESSION} />
        </ApprovalDockProvider>
      </QueryClientProvider>,
    );
    const older = document.querySelector("[data-approval-id='appr-older']");
    const newer = document.querySelector("[data-approval-id='appr-newer']");
    expect(older?.hasAttribute("data-vex-decision-docked")).toBe(true);
    expect(older?.querySelector("[data-vex-area='approval-foot']")).toBeNull();
    // The newer card keeps its footer in the card.
    expect(newer?.hasAttribute("data-vex-decision-docked")).toBe(false);
    expect(newer?.querySelector("[data-vex-area='approval-foot']")).not.toBeNull();
    // One footer in the dock, and it is the focused card's.
    expect(dock.querySelectorAll("[data-vex-area='approval-foot']")).toHaveLength(1);
    expect(dock.contains(document.activeElement)).toBe(true);
    dock.remove();
  });

  it("docks nothing where the panel offers no dock", () => {
    pendingState = { data: { ok: true, data: [makeSummary({ id: "appr-only" })] } };
    renderRegion();
    const card = document.querySelector("[data-approval-id='appr-only']");
    expect(card?.hasAttribute("data-vex-decision-docked")).toBe(false);
    expect(card?.querySelector("[data-vex-area='approval-foot']")).not.toBeNull();
  });
});

describe("ApprovalsRegion, closed confirmations (H3-DESKTOP.md section 4.3; Cloud's EC-09)", () => {
  const waiting = (id: string, createdAt: string) =>
    makeSummary({ id, createdAt, riskLevel: "info", actionKind: "read", expiresAt: "2026-05-28T10:10:00.000Z" });

  function regionWith(rows: ApprovalSummaryDto[]) {
    pendingState = { data: { ok: true, data: rows } };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <ApprovalsRegion sessionId={SESSION} />
      </QueryClientProvider>,
    );
    const rerenderWith = (next: ApprovalSummaryDto[], session = SESSION): void => {
      pendingState = { data: { ok: true, data: next } };
      view.rerender(
        <QueryClientProvider client={qc}>
          <ApprovalsRegion sessionId={session} />
        </QueryClientProvider>,
      );
    };
    return { view, rerenderWith };
  }

  const stackIds = (): (string | null)[] =>
    Array.from(document.querySelectorAll("[data-vex-area='approvals-region'] > [data-approval-id]")).map((el) =>
      el.getAttribute("data-approval-id"),
    );

  it("leaves an expired card's closed card in its place, naming only what the record holds", () => {
    const first = waiting("appr-a", "2026-05-28T10:00:00.000Z");
    const second = waiting("appr-b", "2026-05-28T10:01:00.000Z");
    const { rerenderWith } = regionWith([first, second]);
    records.set("appr-a", {
      ...first,
      status: "rejected",
      decision: "rejected",
      decisionReason: "expired_ttl",
      resolvedAt: "2026-05-28T10:10:01.000Z",
    });
    rerenderWith([second]);
    const closed = document.querySelector("[data-vex-area='approval-closed']");
    expect(closed?.getAttribute("data-vex-closed")).toBe("expired");
    expect(closed?.textContent).toContain("Expired. Nothing was run.");
    // The waiting card beside it keeps its own (empty) failure line, so read the closed card's.
    expect(within(closed as HTMLElement).getByRole("alert").textContent).toBe(
      "This confirmation expired before it was answered.",
    );
    // In its place: still first, the waiting card after it.
    expect(stackIds()).toEqual(["appr-a", "appr-b"]);
    // No network, no stamp, no outcome the record does not hold.
    expect(closed?.textContent).not.toMatch(/mainnet|real funds|not submitted/i);
    expect(closed?.querySelector(".vex-stamp, .vex-rf")).toBeNull();
    // Its next key takes it away.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector("[data-vex-area='approval-closed']")).toBeNull();
    expect(stackIds()).toEqual(["appr-b"]);
  });

  it("says the person rejected only after a rejection on this card", () => {
    const only = waiting("appr-a", "2026-05-28T10:00:00.000Z");
    const reply: ApprovalActionResult = {
      id: "appr-a",
      status: "rejected",
      resolvedAt: "2026-05-28T10:02:00.000Z",
      runtimeOutcome: "resumed",
      executionStatus: null,
      missionRunId: null,
      cached: false,
      message: "Rejected.",
    };
    rejectMutate.mockImplementation((_input, options) => options?.onSuccess?.({ ok: true, data: reply }));
    const { rerenderWith } = regionWith([only]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    });
    rerenderWith([]);
    const closed = document.querySelector("[data-vex-area='approval-closed']");
    expect(closed?.getAttribute("data-vex-closed")).toBe("rejected");
    expect(closed?.textContent).toContain("Rejected. Nothing was run.");
    expect(closed?.textContent).toContain("You chose to reject.");
    expect(screen.getByRole("alert").textContent).toBe("You rejected it, so nothing from this confirmation ran.");
  });

  it("says Result uncertain with Agent Scan next for an approve the engine could not prove", () => {
    const only = waiting("appr-a", "2026-05-28T10:00:00.000Z");
    const { rerenderWith } = regionWith([only]);
    records.set("appr-a", { ...only, status: "approved", decision: "approved", executionStatus: "indeterminate" });
    rerenderWith([]);
    expect(screen.getByRole("alert").textContent).toBe("The result is uncertain. Check Agent Scan before trying again.");
    // Answered elsewhere: no "You chose" line is claimed.
    expect(document.body.textContent).not.toContain("You chose");
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Scan" }));
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "agentScan", origin: null, sessionId: SESSION });
  });

  it("draws no closed card for an approve that settled, and leaves no empty place", () => {
    const only = waiting("appr-a", "2026-05-28T10:00:00.000Z");
    const { view, rerenderWith } = regionWith([only]);
    records.set("appr-a", { ...only, status: "approved", decision: "approved", executionStatus: "succeeded" });
    rerenderWith([]);
    expect(document.querySelector("[data-vex-area='approval-closed']")).toBeNull();
    expect(view.container.firstChild).toBeNull();
  });

  it("reads a row still being dispatched again rather than guess", () => {
    const only = waiting("appr-a", "2026-05-28T10:00:00.000Z");
    vi.useFakeTimers();
    try {
      const { rerenderWith } = regionWith([only]);
      records.set("appr-a", { ...only, status: "approved", decision: "approved", executionStatus: "dispatching" });
      rerenderWith([]);
      expect(document.querySelector("[data-vex-area='approval-closed']")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(refetch).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts every chat with no closed cards", () => {
    const only = waiting("appr-a", "2026-05-28T10:00:00.000Z");
    const { rerenderWith } = regionWith([only]);
    records.set("appr-a", { ...only, status: "rejected", decision: "rejected" });
    rerenderWith([]);
    expect(document.querySelector("[data-vex-area='approval-closed']")).not.toBeNull();
    rerenderWith([], "00000000-0000-4000-8000-00000000aa02");
    expect(document.querySelector("[data-vex-area='approval-closed']")).toBeNull();
  });
});
