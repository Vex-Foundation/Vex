/**
 * GlobalApprovals tests: the app-wide approvals' sync. The count and the list
 * are `features/vex/__tests__/NeedsYouControl.test.tsx`; the cards a Review
 * key opens are the Needs you page
 * (`screens/__tests__/NeedsYouScreen.test.tsx`), which replaced the review
 * dialog.
 *
 * Pins:
 *   - the sync draws nothing and keeps the 60s FALLBACK poll (the list is
 *     push-driven: `useMissionUpdateLiveSync` invalidates `pendingAll` on
 *     `approval_enqueued`); the open page's faster net is 15s;
 *   - the inbox rows come newest first, and an unread or failed read is
 *     `null`, never an empty list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

const { GlobalApprovalsSync, IDLE_POLL_MS, REVIEW_OPEN_POLL_MS, pendingRowsOf } =
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

beforeEach(() => {
  mockApproveMutate.mockReset();
  mockRejectMutate.mockReset();
  refetchIntervals.length = 0;
  decisionInFlight = false;
  pendingState = { data: undefined };
  useUiStore.setState({
    activeSessionId: null,
    shellRoute: { kind: "none" },
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

  it("keeps the open page's faster net at 15s", () => {
    expect(REVIEW_OPEN_POLL_MS).toBe(15_000);
  });

  it("decides nothing", () => {
    pendingState = { data: { ok: true, data: [makeRow()] } };
    render(withClient(<GlobalApprovalsSync />));
    expect(mockApproveMutate).not.toHaveBeenCalled();
    expect(mockRejectMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("pendingRowsOf", () => {
  it("orders the inbox newest first", () => {
    const rows = pendingRowsOf({
      ok: true,
      data: [
        makeRow({ id: "older", createdAt: "2026-05-28T10:00:00.000Z" }),
        makeRow({ id: "newer", createdAt: "2026-05-28T10:05:00.000Z" }),
      ],
    });
    expect(rows?.map((row) => row.id)).toEqual(["newer", "older"]);
  });

  it("is null while unread and after a failed read, never an empty list", () => {
    expect(pendingRowsOf(undefined)).toBeNull();
    expect(pendingRowsOf(errorState().data)).toBeNull();
  });
});
