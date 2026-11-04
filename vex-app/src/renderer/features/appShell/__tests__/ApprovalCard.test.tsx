/**
 * ApprovalCard tests (F3).
 *
 * Pins:
 *   - renders the rich DTO (toolName, namespace, risk + action chips, criticalArgs);
 *   - default focus on Reject when `focusOnMount` (Codex F3 default-focus, UI-UX
 *     "least destructive default");
 *   - two-step confirm for high-risk (riskLevel in {high,critical} OR actionKind in
 *     {destructive,user_wallet_broadcast}): first click arms, second click fires;
 *   - low-risk: single click fires;
 *   - Result.ok=false surfaces as inline error (Codex F3 constraint #1: TanStack
 *     `isError` would not catch application-level Result failures);
 *   - the R3 card (docs/design/R3-MINIMAL.md section 8): the plain sentence,
 *     the money lines with "Not available" where the tool quoted nothing, the
 *     action-named key by tool family, and the row the Needs you page folds a
 *     card to, whose Reject keeps the same two-step confirm;
 *   - the reject reason in H3's words, "Tell Vex what to do instead"
 *     (docs/design/H3-DESKTOP.md Appendix A.7), named as what goes with Reject
 *     and nothing else: no Enter sends it, and Approve never carries it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const { REJECT_REASON_LABEL, REJECT_REASON_PLACEHOLDER } = await import(
  "../ApprovalCard/ApprovalDecisionActions.js"
);

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
  it("offers a reject reason on agent cards and none on desk cards, which have no model to read it", () => {
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalCard summary={makeSummary({ origin: "agent" })} sessionId={SESSION} focusOnMount={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText(REJECT_REASON_LABEL)).toBeTruthy();
    expect(screen.getByText("Vex's own agent")).toBeTruthy();
    unmount();
    renderCard(makeSummary({ origin: "desk" }), false);
    expect(screen.queryByLabelText(REJECT_REASON_LABEL)).toBeNull();
    expect(screen.getByText("You, from the Lighter desk")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: "appr-1" }, expect.anything());
  });

  it("renders the full v4 quote binding, including hook, limits and consequence", () => {
    const binding = "Uniswap v4 pool 0x" + "ab".repeat(32)
      + ", fee dynamic, currently 10000 (millionths), tick spacing 200, hook 0x0000000000000000000000000000000000000044 : this hook can change the output after the swap"
      + " | quoted 100 TEST | will not fill below 99 TEST | input 0.0001 ETH, decimals 18 | Permit2 and Uniswap UniversalRouter 2.1.1"
      + " | The quote is not a guarantee | transaction deadline 600 seconds from signing | Vex fee 25 bps after success | Spends real funds irreversibly after confirmation";
    renderCard(makeSummary({ toolName: "uniswap.swap.execute", preview: { toolName: "uniswap.swap.execute", namespace: "uniswap", criticalArgs: { quoteBinding: binding } } }), false);
    expect(screen.getByTestId("critical-args").textContent).toContain(binding);
  });

  it("renders the plain sentence, the tool, the readable risk tag, the action kind and criticalArgs", () => {
    renderCard(makeSummary(), false);
    // The eyebrow names the act by family (H3-DESKTOP.md Appendix A.7).
    expect(screen.getByText("Confirm this transfer")).toBeTruthy();
    // The title is the plain sentence, built from the present arguments.
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Send 0.5 ETH on Ethereum to 0xabc.");
    expect(screen.getByText("wallet:send")).toBeTruthy();
    // Authored in sentence case; the style capitalises it.
    expect(screen.getByTestId("risk-chip").textContent).toBe("High risk");
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
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  it("names a Lighter create approval's key by its family: Approve order", () => {
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
      screen.getByRole("button", { name: /^approve order$/i }),
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
    ["immediate-or-cancel", "IOC"],
    ["good-till-time", "GTC"],
    ["post-only", "Post-Only"],
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
      screen.getByRole("button", { name: /^approve order$/i }),
    );
    expect(mockApproveMutate).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /confirm approve/i });
    // The second press keeps the app's own words (section 8.4).
    expect(confirm.textContent).toContain(
      "Click again to confirm approve",
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

  it("words the reason as H3 does, and names it as what goes with Reject", () => {
    renderCard(
      makeSummary({ riskLevel: "low", actionKind: "local_write" }),
      false,
    );
    expect(REJECT_REASON_PLACEHOLDER).toBe("Tell Vex what to do instead");
    expect(REJECT_REASON_LABEL).toBe("Tell Vex what to do instead (optional, sent when you reject)");
    const field = screen.getByRole("textbox", { name: REJECT_REASON_LABEL });
    expect(field.getAttribute("placeholder")).toBe(REJECT_REASON_PLACEHOLDER);
    // The old words are gone from the card.
    expect(screen.queryByPlaceholderText("Reason (optional)")).toBeNull();
    expect(screen.queryByLabelText("Reason for rejecting (optional)")).toBeNull();
  });

  it("sends nothing on Enter in the reason: it travels with Reject only", () => {
    renderCard(
      makeSummary({ riskLevel: "low", actionKind: "local_write" }),
      false,
    );
    const field = screen.getByRole("textbox", { name: REJECT_REASON_LABEL });
    fireEvent.change(field, { target: { value: "Use USDC on Base instead" } });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    expect(mockRejectMutate).not.toHaveBeenCalled();
    expect(mockApproveMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(mockRejectMutate).toHaveBeenCalledWith(
      { id: "appr-1", reason: "Use USDC on Base instead" },
      expect.any(Object),
    );
  });

  it("sends the typed reason with the reject payload", () => {
    renderCard(
      makeSummary({ riskLevel: "low", actionKind: "local_write" }),
      false,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: REJECT_REASON_LABEL }),
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
      screen.getByRole("textbox", { name: REJECT_REASON_LABEL }),
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
      screen.getByRole("textbox", { name: REJECT_REASON_LABEL }),
      { target: { value: "not this one" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));

    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: "appr-1" },
      expect.any(Object),
    );
  });

  it("high-risk approve needs TWO clicks (first arms, second fires)", () => {
    renderCard(makeSummary(), false);
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Wallet rejected the request.",
    );
  });

  it("invalidates approval queries when approve returns a Result-level failure", async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries").mockResolvedValue();
    mockApproveMutate.mockImplementation((_input, options) => {
      void options?.onSuccess?.({
        ok: false,
        error: {
          code: "approvals.dispatch_failed",
          domain: "approvals",
          message: "Dispatch failed.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: "req-y",
        },
      });
    });

    renderCard(makeSummary({ origin: "desk", riskLevel: "info", actionKind: "read" }), false);
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["approvals", "pending", SESSION] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["approvals", "history", SESSION] });
    invalidate.mockRestore();
  });

  // S5 signed glint — the ONE success light in the approvals flow.
  it("renders the one-shot signed glint after a successful approve", () => {
    mockApproveMutate.mockImplementation((_input, options) => {
      void options?.onSuccess?.({ ok: true, data: {} });
    });
    renderCard(makeSummary({ riskLevel: "info", actionKind: "read" }), false);
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
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

  it("buttons disabled while a mutation is in-flight, and the approve key says it is working", () => {
    approvePending = true;
    renderCard(
      makeSummary({ riskLevel: "info", actionKind: "read" }),
      false,
    );
    // The key the user pressed names what it is doing and is marked busy; a
    // dispatch can run for fifteen seconds, and a key that only dimmed for
    // that long read as a click that never landed.
    const approve = screen.getByRole("button", { name: /working, please wait/i });
    const reject = screen.getByRole("button", { name: /^reject$/i });
    expect(approve.getAttribute("disabled")).not.toBeNull();
    expect(reject.getAttribute("disabled")).not.toBeNull();
    expect(approve.getAttribute("aria-busy")).toBe("true");
    // The working key keeps its blue fill and leads with the ongoing swatch
    // (status by fill); the retired travelling lane is gone.
    expect(approve.hasAttribute("data-vex-approve-working")).toBe(true);
    expect(approve.querySelector('.vex-swatch[data-s="ongoing"]')).not.toBeNull();
    expect(approve.className).not.toContain("disabled:border-dotted");
    expect(approve.className).not.toContain("vex-ring-working");
  });

  it("leaves the approve key alone while a REJECTION is the thing in flight", () => {
    // `inFlight` covers both mutations. The working swatch marks the key that
    // was actually pressed, so a running rejection must not light Approve.
    rejectPending = true;
    renderCard(
      makeSummary({ riskLevel: "info", actionKind: "read" }),
      false,
    );
    const approve = screen.getByRole("button", { name: /^approve transfer$/i });
    expect(approve.getAttribute("disabled")).not.toBeNull();
    expect(approve.hasAttribute("data-vex-approve-working")).toBe(false);
    expect(approve.querySelector(".vex-swatch")).toBeNull();
    // An inert primary is the dotted outline, never a faded fill.
    expect(approve.className).toContain("disabled:border-dotted");
    expect(approve.getAttribute("aria-busy")).toBe("false");
  });
  describe("click responsiveness (K-2 B1)", () => {
    const LOW = { riskLevel: "info", actionKind: "read" } as const;

    it("locks both keys on the click itself and sends exactly one decision on a double click", () => {
      // The mutation never reports back, and the mocked `isPending` stays
      // false: the lock comes from the click alone.
      renderCard(makeSummary(LOW), false);
      const approveKey = screen.getByRole("button", { name: /^approve transfer$/i });
      fireEvent.click(approveKey);
      fireEvent.click(approveKey);
      expect(mockApproveMutate).toHaveBeenCalledTimes(1);
      const working = screen.getByRole("button", { name: /working, please wait/i });
      expect(working.getAttribute("disabled")).not.toBeNull();
      expect(working.getAttribute("aria-busy")).toBe("true");
      const rejectKey = screen.getByRole("button", { name: /^reject$/i });
      expect(rejectKey.getAttribute("disabled")).not.toBeNull();
      fireEvent.click(rejectKey);
      expect(mockRejectMutate).not.toHaveBeenCalled();
    });

    it("names a running rejection on the reject key", () => {
      renderCard(makeSummary(LOW), false);
      fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
      fireEvent.click(screen.getByRole("button", { name: /rejecting, please wait/i }));
      expect(mockRejectMutate).toHaveBeenCalledTimes(1);
      const rejecting = screen.getByRole("button", { name: /rejecting, please wait/i });
      expect(rejecting.textContent).toBe("Rejecting");
      expect(rejecting.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByRole("button", { name: /^approve transfer$/i }).getAttribute("disabled")).not.toBeNull();
    });

    it("hands the outcome over before the query refresh has finished", () => {
      // A refresh that never settles: the outcome must not wait on it.
      const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries")
        .mockReturnValue(new Promise<void>(() => undefined));
      const onResolved = vi.fn();
      const data = {
        id: "appr-1",
        status: "approved",
        resolvedAt: null,
        runtimeOutcome: "stopped",
        executionStatus: "succeeded",
        missionRunId: null,
        cached: false,
        message: "Approved. Tool executed.",
      } as const;
      mockApproveMutate.mockImplementation((_input, options) => {
        void options?.onSuccess?.({ ok: true, data });
      });
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ApprovalCard summary={makeSummary(LOW)} sessionId={SESSION} focusOnMount={false} onResolved={onResolved} />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
      expect(onResolved).toHaveBeenCalledWith("approved", data);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["approvals", "pending", SESSION] });
      // The card stays inert until the refreshed list removes it.
      const settled = screen.getByRole("button", { name: /^approved$/i });
      expect(settled.getAttribute("disabled")).not.toBeNull();
      expect(screen.getByRole("button", { name: /^reject$/i }).getAttribute("disabled")).not.toBeNull();
      invalidate.mockRestore();
    });

    it("hands a rejection over before the query refresh has finished", () => {
      const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries")
        .mockReturnValue(new Promise<void>(() => undefined));
      const onResolved = vi.fn();
      mockRejectMutate.mockImplementation((_input, options) => {
        void options?.onSuccess?.({ ok: true, data: { id: "appr-1" } });
      });
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ApprovalCard summary={makeSummary(LOW)} sessionId={SESSION} focusOnMount={false} onResolved={onResolved} />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
      expect(onResolved).toHaveBeenCalledWith("rejected", { id: "appr-1" });
      expect(screen.getByRole("button", { name: /^rejected$/i }).getAttribute("disabled")).not.toBeNull();
      invalidate.mockRestore();
    });

    it("unlocks the keys again when the decision fails, with the error shown as before", () => {
      mockApproveMutate.mockImplementation((_input, options) => {
        void options?.onSuccess?.({
          ok: false,
          error: {
            code: "approvals.dispatch_failed",
            domain: "approvals",
            message: "Dispatch failed.",
            retryable: true,
            userActionable: true,
            redacted: true,
            correlationId: "req-z",
          },
        });
      });
      renderCard(makeSummary(LOW), false);
      fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
      expect(screen.getByRole("alert").textContent).toContain("Dispatch failed.");
      expect(screen.getByRole("button", { name: /^approve transfer$/i }).getAttribute("disabled")).toBeNull();
      expect(screen.getByRole("button", { name: /^reject$/i }).getAttribute("disabled")).toBeNull();
    });

    it("unlocks the keys again when the transport itself throws", () => {
      mockRejectMutate.mockImplementation((_input, options) => {
        options?.onError?.(new Error("IPC channel closed."));
      });
      renderCard(makeSummary(LOW), false);
      fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
      expect(screen.getByRole("alert").textContent).toContain("IPC channel closed.");
      expect(screen.getByRole("button", { name: /^reject$/i }).getAttribute("disabled")).toBeNull();
    });
  });
});

/**
 * REAL FUNDS, ON EVERY CARD (docs/design/H3-DESKTOP.md section 4.2). Every
 * desktop wallet is a real wallet, so no approval card that can move funds
 * may render without MAINNET and the REAL FUNDS stamp in its eyebrow row -
 * whatever its risk, its action kind or its origin. H3's card is a square
 * cell bounded by 1px rules (section 2.4), and its stamp carries the hatch
 * glyph R3 drew as a band down the card's edge; both are pinned against the
 * card's own sheet (approval.css).
 */
const BRIDGE_PREVIEW = {
  toolName: "BridgeExecute",
  criticalArgs: {
    fromChain: "8453",
    toChain: "42161",
    amountRaw: "1000000",
    slippageBps: 50,
    bridgeAmount: "1 USDC | 1000000 raw units | 6 decimals",
    vexFee:
      "Vex fee 0.25% (25 bps): 0.0025 USDC | 2500 raw units | 6 decimals, taken on the input token as a separate transfer after the bridge confirms.",
    safety: "UNVERIFIED - audit unavailable",
  },
} as const;

describe("ApprovalCard, the R3 card", () => {
  it("titles a bridge with its plain sentence and names its key Approve bridge", () => {
    renderCard(makeSummary({ toolName: "BridgeExecute", preview: BRIDGE_PREVIEW }), false);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "Bridge 1 USDC from Base to Arbitrum.",
    );
    expect(screen.getByRole("button", { name: "Approve bridge" })).toBeTruthy();
  });

  it("reads the money lines the tool bound and says Not available for the rest, never a figure", () => {
    renderCard(makeSummary({ toolName: "BridgeExecute", preview: BRIDGE_PREVIEW }), false);
    const money = document.querySelector<HTMLElement>("[data-vex-area='approval-money']");
    expect(money).not.toBeNull();
    const text = money?.textContent ?? "";
    expect(text).toContain("You send");
    expect(text).toContain("1 USDC");
    expect(text).toContain("0.0025 USDC");
    expect(text).toContain("slippage limit 0.5%");
    // The bridge lane binds no expected output, no minimum and no network fee.
    expect(money?.querySelectorAll("[data-vex-money-missing]")).toHaveLength(3);
    expect(text).toContain("Not available");
    // Total debit only when every part is known: the network fee is not.
    expect(text).not.toContain("Total debit");
  });

  it("explains the risk in plain sentences: the high risk and the missing audit", () => {
    renderCard(makeSummary({ toolName: "BridgeExecute", preview: BRIDGE_PREVIEW }), false);
    expect(screen.getByText("High risk:")).toBeTruthy();
    expect(screen.getByText("Unverified, audit unavailable:")).toBeTruthy();
  });

  it("keeps every raw field behind All signed fields, closed while the card has facts to read", () => {
    renderCard(makeSummary({ toolName: "BridgeExecute", preview: BRIDGE_PREVIEW }), false);
    const signed = screen.getByText("All signed fields").closest("details");
    expect(signed).not.toBeNull();
    expect(signed?.open).toBe(false);
    expect(signed?.contains(screen.getByTestId("critical-args"))).toBe(true);
    expect(signed?.contains(screen.getByTestId("approval-proposal"))).toBe(true);
  });

  it("opens the signed fields when they are the only facts the card has", () => {
    renderCard(
      makeSummary({
        toolName: "WalletEvmTransactionConfirm",
        preview: { toolName: "WalletEvmTransactionConfirm", criticalArgs: { chain: "base", recipient: "0xabc" } },
      }),
      false,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toMatch(/: review the signed fields$/);
    expect(screen.getByText("All signed fields").closest("details")?.open).toBe(true);
  });

  it("arms the second press as an ink key, never a second blue fill", () => {
    renderCard(makeSummary(), false);
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
    const armed = screen.getByRole("button", { name: /confirm approve/i });
    expect(armed.className).toContain("border-rule-ink");
    expect(armed.className).toContain("outline-rule-ink");
    expect(armed.className).not.toContain("bg-button-accent ");
  });
});

describe("ApprovalCard folded to its row (the Needs you page)", () => {
  function renderRow(
    summary: ApprovalSummaryDto,
    onReview: () => void = () => undefined,
  ): ReturnType<typeof render> {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalCard
          summary={summary}
          sessionId={SESSION}
          focusOnMount={false}
          idVariant="global"
          layout="row"
          onReview={onReview}
        />
      </QueryClientProvider>,
    );
  }

  it("shows the sentence, REAL FUNDS, Reject and Review by family, and no approve key", () => {
    renderRow(makeSummary({ riskLevel: "info", actionKind: "read" }));
    const card = document.querySelector("[data-vex-area='approval-card']");
    expect(card?.getAttribute("data-vex-approval-layout")).toBe("row");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Send 0.5 ETH on Ethereum to 0xabc.");
    expect(screen.getByTestId("real-funds-stamp").textContent).toBe("Real funds");
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review transfer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^approve/i })).toBeNull();
  });

  it("Review opens the card and decides nothing", () => {
    const onReview = vi.fn();
    renderRow(makeSummary(), onReview);
    fireEvent.click(screen.getByRole("button", { name: "Review transfer" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).not.toHaveBeenCalled();
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });

  it("keeps the two-step reject on a high-risk row", () => {
    renderRow(makeSummary());
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(mockRejectMutate).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /confirm reject/i });
    expect(confirm.textContent).toBe("Click again to confirm reject");
    fireEvent.click(confirm);
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: "appr-1" }, expect.any(Object));
  });

  it("carries an armed key across the fold: the row and the card are one decision", () => {
    const view = renderRow(makeSummary());
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalCard summary={makeSummary()} sessionId={SESSION} focusOnMount={false} idVariant="global" layout="card" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: /confirm reject/i }).textContent).toBe(
      "Click again to confirm reject",
    );
  });
});

describe("ApprovalCard REAL FUNDS treatment", () => {
  const APPROVAL_CSS = readFileSync(
    join(process.cwd(), "src/renderer/styles/global-css/approval.css"),
    "utf8",
  );

  function ruleBody(selector: string): string {
    const at = APPROVAL_CSS.indexOf(`${selector} {`);
    expect(at, `rule missing: ${selector}`).toBeGreaterThan(-1);
    return APPROVAL_CSS.slice(at, APPROVAL_CSS.indexOf("}", at));
  }

  const CASES: ReadonlyArray<readonly [string, Partial<ApprovalSummaryDto>]> = [
    ["a high-risk broadcast", { riskLevel: "high", actionKind: "user_wallet_broadcast" }],
    ["a low-risk read", { riskLevel: "info", actionKind: "read" }],
    ["an unclassified proposal", { riskLevel: null, actionKind: null }],
    ["a desk click", { origin: "desk", riskLevel: "info", actionKind: "read" }],
  ];

  it("does not stamp a call to the user's own MCP tool as real funds, and says what will run", () => {
    renderCard(
      makeSummary({
        toolName: "mcp:deepwiki / read_wiki_structure",
        actionKind: "read",
        riskLevel: "info",
        preview: {
          toolName: "deepwiki / read_wiki_structure",
          namespace: "mcp",
          criticalArgs: { server: "deepwiki", tool: "read_wiki_structure", arguments: '{"repoName":"facebook/react"}' },
        },
      }),
      false,
    );
    expect(screen.queryByTestId("real-funds-stamp")).toBeNull();
    // Nothing is signed, so nothing names a network either.
    expect(screen.queryByTestId("approval-network")).toBeNull();
    expect(screen.getByText("Call read_wiki_structure on your MCP server deepwiki.")).toBeTruthy();
  });

  for (const [label, over] of CASES) {
    it(`stamps ${label} REAL FUNDS on MAINNET in the card's head`, () => {
      renderCard(makeSummary(over), false);
      const card = document.querySelector('[data-vex-area="approval-card"]');
      expect(card).not.toBeNull();
      expect(card?.hasAttribute("data-vex-real-funds")).toBe(true);
      expect(card?.className).toContain("vex-real-funds");
      const stamp = screen.getByTestId("real-funds-stamp");
      expect(stamp.textContent).toBe("Real funds");
      expect(stamp.className).toContain("vex-stamp");
      // The stamp sits in the card's own head, beside the title it qualifies.
      const header = card?.querySelector("header");
      expect(header?.contains(stamp)).toBe(true);
      // MAINNET stands right before it, a statement in the same row.
      const network = screen.getByTestId("approval-network");
      expect(network.textContent).toBe("Mainnet");
      expect(header?.contains(network)).toBe(true);
      expect(network.nextElementSibling).toBe(stamp);
    });
  }

  it("names the act in the eyebrow, as H3 draws it, with no status swatch beside it", () => {
    renderCard(makeSummary(), false);
    const header = document.querySelector('[data-vex-area="approval-card"] header');
    const eyebrow = header?.querySelector(".vex-appr__eyebrow");
    // Sentence case in the source; the eyebrow's style sets the caps.
    expect(eyebrow?.textContent).toBe("Confirm this transfer");
    expect(header?.firstElementChild).toBe(eyebrow);
    expect(header?.textContent).not.toContain("Approval needed");
    expect(header?.querySelector('.vex-swatch[data-s="awaiting"]')).toBeNull();
    expect(header?.innerHTML).not.toContain("--vex-pin");
  });

  it("frames the card as an H3 cell: a 1px rule, square, no shadow and no hatch band, never a hue", () => {
    const frame = ruleBody(".vex-appr");
    expect(frame).toContain("border: 1px solid var(--vex-alias-rule)");
    expect(frame).toContain("background: var(--vex-alias-bg-base)");
    // R3's ink frame and its band are gone; nothing rounds, shadows or blurs.
    const sheet = APPROVAL_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sheet).not.toMatch(/\.vex-real-funds|border-radius|box-shadow|backdrop-filter|1\.5px solid/);
    // Ink only: no status hue and no blue anywhere in the treatment.
    expect(frame).not.toMatch(/#[0-9a-f]{3,8}\b|accent|state-warn|destructive/i);
  });

  it("draws the stamp as H3's ink fill, 23 high, caps 12, led by its hatch glyph", () => {
    const stamp = ruleBody(".vex-appr__top .vex-stamp,\n.vex-appr__top .vex-tag");
    expect(stamp).toContain("height: 23px");
    expect(stamp).toContain("font-size: 12px");
    const glyph = ruleBody(".vex-appr__top .vex-stamp::before");
    expect(glyph).toContain("width: 12px");
    expect(glyph).toMatch(
      /repeating-linear-gradient\(\s*135deg,\s*var\(--vex-alias-label-on-primary\) 0 1\.5px,\s*transparent 1\.5px 4px\s*\)/,
    );
    expect(glyph).not.toMatch(/#[0-9a-f]{3,8}\b|accent|state-warn|destructive/i);
  });

  it("sets the eyebrow and MAINNET as tracked sans caps, and the sentence at 20", () => {
    for (const selector of [".vex-appr__eyebrow", ".vex-appr__net"]) {
      const body = ruleBody(selector);
      expect(body).toContain("font-size: 13px");
      expect(body).toContain("text-transform: uppercase");
      expect(body).toContain("letter-spacing: var(--tracking-label)");
      expect(body).not.toContain("--font-mono");
    }
    expect(ruleBody(".vex-appr__title")).toContain("font-size: 20px");
    expect(ruleBody(".vex-appr__consequence")).toContain("font-size: 15px");
  });
});

describe("ApprovalCard, the H3 head", () => {
  it("reads the eyebrow, the sentence and the consequence line in that order", () => {
    renderCard(makeSummary({ toolName: "BridgeExecute", preview: BRIDGE_PREVIEW }), false);
    const head = document.querySelector<HTMLElement>(".vex-appr__head");
    expect(head).not.toBeNull();
    const eyebrow = head?.querySelector(".vex-appr__eyebrow");
    const title = screen.getByRole("heading", { level: 3 });
    const consequence = screen.getByTestId("approval-consequence");
    expect(eyebrow?.textContent).toBe("Confirm this bridge");
    expect(title.textContent).toBe("Bridge 1 USDC from Base to Arbitrum.");
    expect(consequence.textContent).toBe("This sends real funds on mainnet. It cannot be undone.");
    expect(head?.contains(title)).toBe(true);
    expect(head?.contains(consequence)).toBe(true);
    // Document order: eyebrow row, then the sentence, then the consequence.
    expect(eyebrow?.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(title.compareDocumentPosition(consequence)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("says a swap places a real order that cannot be undone", () => {
    renderCard(
      makeSummary({
        toolName: "execute_tool",
        preview: {
          toolName: "swap.execute",
          namespace: "kyberswap",
          criticalArgs: { toolId: "kyberswap.swap.execute", chain: "base", tokenIn: "USDC", tokenOut: "ETH", amountIn: "200" },
        },
      }),
      false,
    );
    expect(screen.getByText("Confirm this swap")).toBeTruthy();
    expect(screen.getByTestId("approval-consequence").textContent).toBe(
      "This places a real order on mainnet. It cannot be undone.",
    );
  });

  it("shows no consequence line where the family's line would not be true", () => {
    renderCard(
      makeSummary({
        toolName: "WalletEvmTransactionConfirm",
        preview: { toolName: "WalletEvmTransactionConfirm", criticalArgs: { chain: "base", recipient: "0xabc" } },
      }),
      false,
    );
    expect(screen.getByText("Confirm this action")).toBeTruthy();
    expect(screen.queryByTestId("approval-consequence")).toBeNull();
    // The card still says what it does: the risk sentence stays.
    expect(screen.getByText("High risk:")).toBeTruthy();
  });

  it("keeps the expiry and the risk tag in the eyebrow row, read from the approval", () => {
    renderCard(makeSummary({ expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }), false);
    const header = document.querySelector('[data-vex-area="approval-card"] header');
    expect(header?.querySelector(".vex-appr__expiry")?.textContent).toMatch(/^Expires (at )?.+ UTC$/);
    expect(header?.contains(screen.getByTestId("risk-chip"))).toBe(true);
  });

  it("puts no em or en dash in the head", () => {
    renderCard(makeSummary({ toolName: "BridgeExecute", preview: BRIDGE_PREVIEW }), false);
    const head = document.querySelector(".vex-appr__head")?.textContent ?? "";
    expect(head).not.toMatch(new RegExp(`${String.fromCharCode(0x2014)}|${String.fromCharCode(0x2013)}`));
  });
});

describe("ApprovalCard, the H3 table (H3-DESKTOP.md sections 1.7 and 4.1)", () => {
  const APPROVAL_CSS = readFileSync(
    join(process.cwd(), "src/renderer/styles/global-css/approval.css"),
    "utf8",
  );
  /** The body of the rule whose WHOLE selector list is `selector`, never one it shares. */
  const ruleBody = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(APPROVAL_CSS.replace(/\/\*[\s\S]*?\*\//g, ""));
    expect(match, `rule missing: ${selector}`).not.toBeNull();
    return match?.[1] ?? "";
  };
  const SWAP = makeSummary({
    toolName: "execute_tool",
    preview: {
      toolName: "swap.execute",
      namespace: "kyberswap",
      criticalArgs: {
        toolId: "kyberswap.swap.execute",
        chain: "base",
        tokenIn: "USDC",
        tokenOut: "ETH",
        amountIn: "200",
        slippageBps: 50,
        vexFee: "Vex fee 0.25% (25 bps): 0.5 USDC | 500000 raw units | 6 decimals, taken on the input token.",
        quoteBinding: "kyber-quote-v1 | quoted 0.05714 ETH | will not fill below 0.05686 ETH (50 bps of the quote)",
      },
    },
  });

  function moneyRows(): { label: string; value: string; dt: HTMLElement; dd: HTMLElement }[] {
    const money = document.querySelector<HTMLElement>("[data-vex-area='approval-money']");
    expect(money).not.toBeNull();
    const terms = Array.from(money?.querySelectorAll<HTMLElement>("dt") ?? []);
    return terms.map((dt) => {
      const dd = dt.nextElementSibling as HTMLElement;
      return { label: dt.textContent ?? "", value: dd.textContent ?? "", dt, dd };
    });
  }

  it("keeps the same rows and the same data: send, receive, minimum, costs", () => {
    renderCard(SWAP, false);
    const rows = moneyRows();
    expect(rows.map((row) => row.label)).toEqual(["You send", "You receive", "Minimum receipt", "Costs"]);
    expect(rows[0]?.value).toBe("200 USDC · on Base");
    expect(rows[1]?.value).toBe("0.05714 ETH · quoted");
    expect(rows[2]?.value).toBe("0.05686 ETH · slippage limit 0.5%");
    expect(rows[3]?.value).toBe("Vex fee 0.5 USDC (0.25%) · network fee Not available");
    // The network fee is never quoted, so the total stays hidden.
    expect(document.body.textContent).not.toMatch(/total debit/i);
    // H3 rows desktop has no data for are not drawn (section 4.1).
    expect(document.body.textContent).not.toMatch(/quoted price|available 1|your trading wallet|per order/i);
  });

  it("labels every row in the field-label register, in sentence case", () => {
    renderCard(SWAP, false);
    for (const row of moneyRows()) {
      expect(row.dt.classList.contains("vex-field-label")).toBe(true);
      // The register sets the caps; the source stays words.
      expect(row.label).not.toBe(row.label.toUpperCase());
    }
  });

  it("sets every figure in mono and keeps 'Not available' a word, never a figure", () => {
    renderCard(SWAP, false);
    const rows = moneyRows();
    const figures = rows.flatMap((row) => Array.from(row.dd.querySelectorAll(".vex-num")).map((n) => n.textContent));
    expect(figures).toEqual(["200 USDC", "0.05714 ETH", "0.05686 ETH", "0.5 USDC"]);
    const missing = rows.flatMap((row) => Array.from(row.dd.querySelectorAll("[data-vex-money-missing]")));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.classList.contains("vex-num")).toBe(false);
    expect(missing[0]?.textContent).toBe("Not available");
  });

  it("puts a Lighter order's fact rows and a curated tool's rows in the same table", () => {
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalCard
          summary={makeSummary({
            toolName: "lighter:order.create",
            preview: {
              toolName: "order.create",
              namespace: "lighter",
              criticalArgs: {
                toolId: "lighter.order.create",
                side: "buy",
                baseAmountDisplay: "0.0002",
                marketSymbol: "BTC",
                orderType: "market",
                timeInForce: "immediate-or-cancel",
                priceDisplay: "77199.7",
              },
            },
          })}
          sessionId={SESSION}
          focusOnMount={false}
        />
      </QueryClientProvider>,
    );
    const order = screen.getByTestId("order-facts");
    expect(order.className).toBe("vex-appr__dl");
    for (const dt of Array.from(order.querySelectorAll("dt"))) {
      expect(dt.classList.contains("vex-field-label")).toBe(true);
    }
    unmount();
    renderCard(
      makeSummary({
        toolName: "lighter:fees.approve",
        preview: {
          toolName: "fees.approve",
          namespace: "lighter",
          criticalArgs: { toolId: "lighter.fees.approve", summary: "Authorize VEX trading fees", perpetualFee: "0.02%" },
        },
      }),
      false,
    );
    const curated = screen.getByTestId("critical-args");
    expect(curated.className).toBe("vex-appr__dl");
    const labels = Array.from(curated.querySelectorAll("dt"));
    expect(labels.map((dt) => dt.textContent)).toEqual(["Action", "Perpetual fee"]);
    for (const dt of labels) expect(dt.classList.contains("vex-field-label")).toBe(true);
  });

  it("draws each row as a ruled cell edge to edge, the label 24 in at the left and the value 24 in at the right", () => {
    expect(ruleBody(".vex-appr__dl")).toContain("grid-template-columns: fit-content(50%) minmax(0, 1fr)");
    expect(ruleBody(".vex-appr__dl")).toContain("margin: 0;");
    const cell = ruleBody(".vex-appr__dl dt,\n.vex-appr__dl dd");
    expect(cell).toContain("border-top: 1px solid var(--vex-alias-rule)");
    expect(cell).toContain("padding: 8px 0");
    expect(cell).toContain("line-height: 17px");
    const label = ruleBody(".vex-appr__dl dt");
    expect(label).toContain("padding-left: 24px");
    expect(label).toContain("color: var(--vex-alias-label-tertiary)");
    // The register owns the label's face, size and caps; the table never overrides them.
    expect(label).not.toMatch(/font-family|font-size|text-transform|letter-spacing/);
    const value = ruleBody(".vex-appr__dl dd");
    expect(value).toContain("text-align: right");
    expect(value).toContain("padding-right: 24px");
    expect(value).toContain("font-size: 14px");
  });
});
