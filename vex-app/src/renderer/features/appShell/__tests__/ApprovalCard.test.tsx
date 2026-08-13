/**
 * ApprovalCard tests (F3).
 *
 * Pins:
 *   - renders the rich DTO (toolName, namespace, risk + action chips, criticalArgs);
 *   - default focus on Reject when `focusOnMount` (Codex F3 default-focus / UI-UX
 *     "least destructive default");
 *   - two-step confirm for high-risk (riskLevel in {high,critical} OR actionKind in
 *     {destructive,user_wallet_broadcast}) — first click arms, second click fires;
 *   - low-risk: single click fires;
 *   - Result.ok=false surfaces as inline error (Codex F3 constraint #1 — TanStack
 *     `isError` would not catch application-level Result failures).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";

const mockApproveMutate = vi.fn();
const mockRejectMutate = vi.fn();
let approvePending = false;
let rejectPending = false;

vi.mock("../../../lib/api/approvals.js", () => ({
  useApprove: () => ({
    mutate: mockApproveMutate,
    isPending: approvePending,
  }),
  useReject: () => ({
    mutate: mockRejectMutate,
    isPending: rejectPending,
  }),
  // Not used by ApprovalCard directly; satisfy the import surface for adjacent
  // modules that might be re-resolved during the test run.
  usePendingApprovals: vi.fn(),
}));

const { ApprovalCard } = await import("../ApprovalCard.js");

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
    reasoningPreview: "Send 0.5 ETH for the bridge proposal.",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: {
      toolName: "send",
      namespace: "wallet",
      criticalArgs: {
        chain: "ethereum",
        asset: "ETH",
        amount: "0.5",
        recipient: "0xabc",
      },
    },
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    ...over,
  };
}

function renderCard(
  summary: ApprovalSummaryDto,
  focusOnMount: boolean,
): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ApprovalCard
        summary={summary}
        sessionId={SESSION}
        focusOnMount={focusOnMount}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApproveMutate.mockReset();
  mockRejectMutate.mockReset();
  approvePending = false;
  rejectPending = false;
});

describe("ApprovalCard", () => {
  it("renders toolName, namespace, risk + action chips, and criticalArgs", () => {
    renderCard(makeSummary(), false);
    expect(screen.getByText(/Approval needed:/)).toBeTruthy();
    expect(screen.getByText("wallet:send")).toBeTruthy();
    expect(screen.getByTestId("risk-chip").textContent).toBe("high");
    expect(screen.getByTestId("action-chip").textContent).toBe(
      "user_wallet_broadcast",
    );
    const args = screen.getByTestId("critical-args");
    expect(args.textContent).toContain("chain");
    expect(args.textContent).toContain("ethereum");
    expect(args.textContent).toContain("amount");
    expect(args.textContent).toContain("0.5");
    expect(args.textContent).toContain("recipient");
    expect(args.textContent).toContain("0xabc");
  });

  it("renders the Vex fee as its own labelled line, not as the raw key", () => {
    renderCard(
      makeSummary({
        preview: {
          toolName: "swap.execute",
          namespace: "kyberswap",
          criticalArgs: {
            amountIn: "1.5",
            vexFee: "0.25% (25 bps) — 0.00375 ETH. Taken on the input token.",
          },
        },
      }),
      false,
    );
    const args = screen.getByTestId("critical-args");
    expect(args.textContent).toContain("Vex fee");
    expect(args.textContent).toContain("0.25% (25 bps) — 0.00375 ETH.");
    expect(args.textContent).not.toContain("vexFee");
  });

  it("omits the fee line entirely when the preview carries no fee — never '0'", () => {
    renderCard(makeSummary(), false);
    const args = screen.getByTestId("critical-args");
    expect(args.textContent).not.toContain("Vex fee");
  });

  it("low-risk: single click on Approve fires mutate", () => {
    renderCard(
      makeSummary({ riskLevel: "info", actionKind: "read" }),
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  it("labels Lighter create approvals as approve-and-execute trades", () => {
    renderCard(
      makeSummary({
        riskLevel: "info",
        actionKind: "external_post",
        toolName: "execute_tool",
        preview: {
          toolName: "order.create",
          namespace: "lighter",
          criticalArgs: {
            toolId: "lighter.order.create",
            intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
            environment: "rhc",
            side: "buy",
          },
        },
      }),
      false,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /^approve and execute trade$/i }),
    );

    expect(screen.getByText("lighter:order.create")).toBeTruthy();
    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  it("keeps the two-click guard on high-risk Lighter create approvals", () => {
    renderCard(
      makeSummary({
        riskLevel: "high",
        actionKind: "external_post",
        toolName: "execute_tool",
        preview: {
          toolName: "order.create",
          namespace: "lighter",
          criticalArgs: {
            toolId: "lighter.order.create",
            intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
          },
        },
      }),
      false,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /^approve and execute trade$/i }),
    );
    expect(mockApproveMutate).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /confirm approve/i });
    expect(confirm.textContent).toContain(
      "Click again to approve and execute trade",
    );
    fireEvent.click(confirm);
    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  it("low-risk: single click on Reject fires mutate", () => {
    renderCard(
      makeSummary({ riskLevel: "low", actionKind: "local_write" }),
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(mockRejectMutate).toHaveBeenCalledTimes(1);
    expect(mockRejectMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  // ── A7: the operator's reject reason reaches the engine ────────────────
  //
  // `prepareReject` always accepted a reason but nothing ever sent one, so
  // every refusal reached the model as "No reason provided" and the agent had
  // nothing to adapt to.

  it("sends the typed reason with the reject payload", () => {
    renderCard(
      makeSummary({ riskLevel: "low", actionKind: "local_write" }),
      false,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /reason for rejecting/i }),
      { target: { value: "Slippage too high" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    expect(mockRejectMutate).toHaveBeenCalledWith(
      { id: "appr-1", reason: "Slippage too high" },
      expect.any(Object),
    );
  });

  it("omits `reason` entirely when blank (strict schema + engine default)", () => {
    renderCard(
      makeSummary({ riskLevel: "low", actionKind: "local_write" }),
      false,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /reason for rejecting/i }),
      { target: { value: "   " } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    const payload = mockRejectMutate.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({ id: "appr-1" });
    expect(payload).not.toHaveProperty("reason");
  });

  it("the reason never rides along to an APPROVE payload", () => {
    renderCard(
      makeSummary({ riskLevel: "low", actionKind: "local_write" }),
      false,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /reason for rejecting/i }),
      { target: { value: "not this one" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  it("high-risk approve needs TWO clicks (first arms, second fires)", () => {
    renderCard(makeSummary(), false);
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(mockApproveMutate).not.toHaveBeenCalled();
    // After arming, the same button now has aria-label "Confirm approve".
    fireEvent.click(screen.getByRole("button", { name: /confirm approve/i }));
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
  });

  it("high-risk reject also needs two clicks (parity with approve)", () => {
    renderCard(makeSummary({ riskLevel: "critical" }), false);
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(mockRejectMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirm reject/i }));
    expect(mockRejectMutate).toHaveBeenCalledTimes(1);
  });

  // INVARIANT (A-055): the high-risk gate must arm on the ACTION KIND alone,
  // independent of riskLevel. With a benign riskLevel (info/low/null) but a
  // dangerous actionKind, the two-click confirm must still fire — proving the
  // extracted `isHighRisk` classifier preserves the OR over actionKind and the
  // confirm gate in the component was not weakened by the split.
  it.each(["info", "low", null] as const)(
    "destructive actionKind arms the two-click gate even when riskLevel=%s",
    (riskLevel) => {
      renderCard(
        makeSummary({ riskLevel, actionKind: "destructive" }),
        false,
      );
      // First approve click only arms — must NOT call onApprove yet.
      fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
      expect(mockApproveMutate).not.toHaveBeenCalled();
      // The button now exposes the confirm label/aria-label.
      const confirm = screen.getByRole("button", {
        name: /confirm approve/i,
      });
      expect(confirm.textContent).toContain("Click again to confirm approve");
      // Second click fires.
      fireEvent.click(confirm);
      expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["info", "low", null] as const)(
    "user_wallet_broadcast actionKind arms the two-click gate even when riskLevel=%s",
    (riskLevel) => {
      renderCard(
        makeSummary({ riskLevel, actionKind: "user_wallet_broadcast" }),
        false,
      );
      fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
      expect(mockApproveMutate).not.toHaveBeenCalled();
      const confirm = screen.getByRole("button", {
        name: /confirm approve/i,
      });
      expect(confirm.textContent).toContain("Click again to confirm approve");
      fireEvent.click(confirm);
      expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    },
  );

  it("focusOnMount=true focuses the Reject button on first mount", () => {
    renderCard(
      makeSummary({ riskLevel: "info", actionKind: "read" }),
      true,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^reject$/i }),
    );
  });

  it("Result.ok=false on approve surfaces an inline alert (Codex F3 #1)", () => {
    mockApproveMutate.mockImplementation((_input, options) => {
      // TanStack `isError` would NOT catch this — it's a Result-level failure.
      void options?.onSuccess?.({
        ok: false,
        error: {
          code: "approvals.dispatch_failed",
          domain: "approvals",
          message: "Wallet rejected the request.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: "req-x",
        },
      });
    });
    renderCard(
      makeSummary({ riskLevel: "info", actionKind: "read" }),
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Wallet rejected the request.",
    );
  });

  // S5 signed glint — the ONE success light in the approvals flow.
  it("renders the one-shot signed glint after a successful approve", () => {
    mockApproveMutate.mockImplementation((_input, options) => {
      void options?.onSuccess?.({ ok: true, data: {} });
    });
    renderCard(makeSummary({ riskLevel: "info", actionKind: "read" }), false);
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(document.querySelector("[data-vex-signed-glint]")).not.toBeNull();
  });

  it("never lights the glint on reject (one-light rule)", () => {
    mockRejectMutate.mockImplementation((_input, options) => {
      void options?.onSuccess?.({ ok: true, data: {} });
    });
    renderCard(makeSummary({ riskLevel: "info", actionKind: "read" }), false);
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(document.querySelector("[data-vex-signed-glint]")).toBeNull();
  });

  it("buttons disabled while a mutation is in-flight", () => {
    approvePending = true;
    renderCard(
      makeSummary({ riskLevel: "info", actionKind: "read" }),
      false,
    );
    const approve = screen.getByRole("button", { name: /^approve$/i });
    const reject = screen.getByRole("button", { name: /^reject$/i });
    expect(approve.getAttribute("disabled")).not.toBeNull();
    expect(reject.getAttribute("disabled")).not.toBeNull();
  });
});
