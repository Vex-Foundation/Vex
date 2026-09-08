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
    origin: null,
    projectId: null,
    requestedByClient: null,
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
            vexFee: "0.25% (25 bps) - 0.00375 ETH. Taken on the input token.",
          },
        },
      }),
      false,
    );
    const args = screen.getByTestId("critical-args");
    expect(args.textContent).toContain("Vex fee");
    expect(args.textContent).toContain("0.25% (25 bps) - 0.00375 ETH.");
    expect(args.textContent).not.toContain("vexFee");
  });

  it("omits the fee line entirely when the preview carries no fee - never '0'", () => {
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

  it.each(["market", "limit"] as const)(
    "labels an ordinary Lighter %s IOC timestamp as unsent with signed expiry zero",
    (orderType) => {
    renderCard(
      makeSummary({
        preview: {
          toolName: "order.create",
          namespace: "lighter",
          criticalArgs: {
            toolId: "lighter.order.create",
            orderType,
            timeInForce: "immediate-or-cancel",
            orderExpiryIso: "2030-01-01T00:00:00.000Z",
          },
        },
      }),
      false,
    );

    const args = screen.getByTestId("critical-args");
    expect(args.textContent).toContain("Unsent expiry reference (signed expiry 0)");
    expect(args.textContent).toContain("2030-01-01T00:00:00.000Z");
    expect(args.textContent).not.toContain("orderExpiryIso");
    },
  );

  it.each([
    ["immediate-or-cancel", "Immediate only"],
    ["good-till-time", "Keep open"],
    ["post-only", "Maker only"],
  ] as const)("shows %s as the plain-language order behavior", (timeInForce, behaviorLabel) => {
    renderCard(
      makeSummary({
        preview: {
          toolName: "order.create",
          namespace: "lighter",
          criticalArgs: {
            toolId: "lighter.order.create",
            orderType: "limit",
            timeInForce,
          },
        },
      }),
      false,
    );

    const args = screen.getByTestId("critical-args");
    expect(args.textContent).toContain("Order behavior");
    expect(args.textContent).toContain(behaviorLabel);
    expect(args.textContent).not.toContain(timeInForce);
  });

  it("does not relabel an unrelated numeric timeInForce field", () => {
    renderCard(
      makeSummary({
        preview: {
          toolName: "order.cancelAll",
          namespace: "lighter",
          criticalArgs: {
            toolId: "lighter.order.cancelAll",
            timeInForce: 0,
          },
        },
      }),
      false,
    );

    const args = screen.getByTestId("critical-args");
    expect(args.textContent).toContain("timeInForce");
    expect(args.textContent).toContain("0");
    expect(args.textContent).not.toContain("Order behavior");
  });

  it.each([
    "stop-loss",
    "stop-loss-limit",
    "take-profit",
    "take-profit-limit",
  ] as const)("labels protective Lighter %s IOC expiry as a signed trigger-order expiry", (orderType) => {
    renderCard(
      makeSummary({
        preview: {
          toolName: "order.create",
          namespace: "lighter",
          criticalArgs: {
            toolId: "lighter.order.create",
            orderType,
            timeInForce: "immediate-or-cancel",
            orderExpiryIso: "2030-01-01T00:00:00.000Z",
          },
        },
      }),
      false,
    );

    expect(screen.getByTestId("critical-args").textContent).toContain(
      "Signed trigger-order expiry",
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

  it("labels Lighter deposits explicitly and requires the high-risk two-click guard", () => {
    renderCard(
      makeSummary({
        riskLevel: "high",
        actionKind: "user_wallet_broadcast",
        toolName: "execute_tool",
        preview: {
          toolName: "deposit",
          namespace: "lighter",
          criticalArgs: {
            toolId: "lighter.deposit",
            intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
            amountDisplay: "11",
            depositTo: "0x1111111111111111111111111111111111111111",
          },
        },
      }),
      false,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /^approve and deposit$/i }),
    );
    expect(mockApproveMutate).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /confirm approve/i });
    expect(confirm.textContent).toContain("Click again to approve and deposit");

    fireEvent.click(confirm);
    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  it.each([false,true])("shows both Lighter fee rates and preserves two-click consent (revoke=%s)", (revoke) => {
    renderCard(makeSummary({ toolName:"execute_tool",expiresAt:"2030-01-01T00:15:00.000Z",
      preview:{ namespace:"lighter",toolName:"fees.approve",criticalArgs:{ toolId:"lighter.fees.approve",revoke,
        summary:revoke?"Revoke VEX trading fees":"Authorize VEX trading fees",
        perpetualFee:"0.1% maker / 0.1% taker of executed trade value",
        spotFee:"0.25% maker / 0.25% taker of executed trade value",recipient:"VEX · Lighter account 99",
        authorizationValidUntil:revoke?"Revoked":"2040-01-01T00:00:00.000Z",
        exchangeFees:"Up to 0.005% maker / 0.005% taker; separate from VEX fees",publicKey:"ab".repeat(40),
      } } }),true);
    expect(screen.getByText("Perpetual fee")).toBeTruthy();expect(screen.getByText("Spot fee")).toBeTruthy();
    expect(screen.getByText("Authorization valid until")).toBeTruthy();
    expect(screen.getByText("2030-01-01T00:15:00.000Z")).toBeTruthy();
    expect(screen.queryByText("ab".repeat(40))).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button",{ name:/^reject$/i }));
    fireEvent.click(screen.getByRole("button",{ name:revoke?"Revoke trading fees":"Approve trading fees" }));
    expect(mockApproveMutate).not.toHaveBeenCalled();
    const confirm=screen.getByRole("button",{ name:"Confirm approve" });
    expect(confirm.textContent).toContain(revoke?"Click again to revoke trading fees":"Click again to approve trading fees");
    fireEvent.click(confirm);expect(mockApproveMutate).toHaveBeenCalledTimes(1);
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
