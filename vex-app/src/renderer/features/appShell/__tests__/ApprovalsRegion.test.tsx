/**
 * ApprovalsRegion tests (F3).
 *
 * Pins:
 *   - empty pending list → renders nothing (no chrome to hide composer);
 *   - Result.ok=false → renders inline error (Codex F3 #1);
 *   - one pending row → renders one ApprovalCard with the right id;
 *   - the FIRST newly-appearing card gets `focusOnMount` (Codex F3 #3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";

type PendingData =
  | { data: Result<ReadonlyArray<ApprovalSummaryDto>> }
  | { data: undefined };

let pendingState: PendingData = { data: undefined };

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => pendingState,
  useApprove: () => ({ mutate: vi.fn(), isPending: false }),
  useReject: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { ApprovalsRegion } = await import("../ApprovalsRegion.js");

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
    expect(screen.getByText(/Approval needed:/)).toBeTruthy();
    expect(screen.getByText("wallet:send")).toBeTruthy();
    // data-approval-id reflects the DTO id (used by integration / debug).
    const card = document.querySelector("[data-approval-id='appr-only']");
    expect(card).not.toBeNull();
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
});
