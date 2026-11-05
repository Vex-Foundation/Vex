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

  it("says a failure as Cloud's one ink line with the cross, right above the decision band (DG5-28)", () => {
    mockApproveMutate.mockImplementation((_input, options) => {
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
    renderCard(makeSummary({ riskLevel: "info", actionKind: "read" }), false);
    fireEvent.click(screen.getByRole("button", { name: /^approve transfer$/i }));
    const line = screen.getByRole("alert");
    expect(line.classList.contains("vex-appr__fail")).toBe(true);
    expect(line.getAttribute("data-vex-area")).toBe("approval-failure");
    // The cross is the ink error swatch, the words follow it; nothing is red.
    expect(line.firstElementChild?.getAttribute("data-s")).toBe("error");
    expect(line.textContent).toBe("Wallet rejected the request.");
    expect(line.className).not.toMatch(/danger|red|err/);
    // The decision band follows it at once: the line is the last cell above the footer.
    expect(line.nextElementSibling?.getAttribute("data-vex-area")).toBe("approval-foot");
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

  it("buttons disabled while a mutation is in-flight, and the approve key says Approving…", () => {
    approvePending = true;
    renderCard(
      makeSummary({ riskLevel: "info", actionKind: "read" }),
      false,
    );
    // The key the user pressed names what it is doing and is marked busy; a
    // dispatch can run for fifteen seconds, and a key that only dimmed for
    // that long read as a click that never landed.
    const approve = screen.getByRole("button", { name: /^approving, please wait$/i });
    const reject = screen.getByRole("button", { name: /^reject$/i });
    // Cloud's own in-flight word (Appendix A.7), the ellipsis drawn, not spoken.
    expect(approve.textContent).toContain("Approving…");
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
    // An inert primary is HELD (Cloud's kit): the sheet draws the cell
    // ground and the muted word from `disabled`, never a dotted blue outline.
    expect(approve.className).not.toMatch(/disabled:(border-dotted|border-accent|text-accent|bg-transparent)/);
    expect(approve.getAttribute("aria-busy")).toBe("false");
  });

  it("draws a key that cannot act as Cloud's held key: the cell ground, the muted word, the 7% edge, no blue", () => {
    const sheet = readFileSync(join(process.cwd(), "src/renderer/styles/global-css/approval.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
      expect(match, `rule missing: ${selector}`).not.toBeNull();
      return match?.[1] ?? "";
    };
    const held = rule(".vex-appr__foot > button:disabled:not([data-vex-approve-working])");
    expect(held).toContain("background: var(--vex-alias-bg-layer-3)");
    expect(held).toContain("color: var(--vex-alias-label-tertiary)");
    expect(held).toContain("border-color: var(--vex-alias-rule)");
    expect(held).toContain("border-style: solid");
    expect(held).not.toMatch(/accent|opacity|dotted/);
    // A running rejection keeps the held ground with its word in ink; the
    // working approve key is pending, not held, and keeps its blue.
    expect(rule('.vex-appr__foot > button[data-vex-key="reject"][aria-busy="true"]:disabled')).toContain(
      "color: var(--vex-alias-label-primary)",
    );
    expect(rule(".vex-appr-row__go > button:disabled")).toContain("background: var(--vex-alias-bg-layer-3)");
    // Nothing on the keys draws a held state of its own any more.
    rejectPending = true;
    renderCard(makeSummary({ riskLevel: "info", actionKind: "read" }), false);
    for (const key of screen.getAllByRole("button")) {
      if (key.closest('[data-vex-area="approval-foot"]') === null) continue;
      expect(key.className).not.toMatch(/disabled:(border-dotted|text-accent|bg-transparent|text-ink-tertiary)/);
    }
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
      const working = screen.getByRole("button", { name: /^approving, please wait$/i });
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
      expect(rejecting.textContent).toBe("Rejecting…");
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

  it("draws the stamp as Cloud's ink tag, 24 high, caps 11 at 400, a 1px ink edge, led by its 10 x 14 hatch", () => {
    const stamp = ruleBody(".vex-appr__top .vex-stamp,\n.vex-appr__top .vex-tag");
    expect(stamp).toContain("height: 24px");
    expect(stamp).toContain("font-size: 11px");
    expect(stamp).toContain("font-weight: 400");
    const own = ruleBody(".vex-appr__top .vex-stamp");
    expect(own).toContain("padding: 0 8px 0 3px");
    expect(own).toContain("border: 1px solid var(--vex-alias-rule-ink)");
    const glyph = ruleBody(".vex-appr__top .vex-stamp::before");
    expect(glyph).toContain("width: 10px");
    expect(glyph).toContain("height: 14px");
    expect(glyph).toMatch(
      /repeating-linear-gradient\(\s*135deg,\s*var\(--vex-alias-label-on-primary\) 0 1\.5px,\s*transparent 1\.5px 4px\s*\)/,
    );
    expect(glyph).not.toMatch(/#[0-9a-f]{3,8}\b|accent|state-warn|destructive/i);
  });

  it("sets the eyebrow and MAINNET as tracked sans caps, and the sentence at Cloud's 18 / 1.3", () => {
    for (const selector of [".vex-appr__eyebrow", ".vex-appr__net"]) {
      const body = ruleBody(selector);
      expect(body).toContain("font-size: 13px");
      expect(body).toContain("text-transform: uppercase");
      expect(body).toContain("letter-spacing: var(--tracking-label)");
      expect(body).not.toContain("--font-mono");
    }
    const title = ruleBody(".vex-appr__title");
    expect(title).toContain("font-size: 18px");
    expect(title).toContain("line-height: 1.3");
    expect(title).toContain("letter-spacing: -0.01em");
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
    expect(consequence.textContent).toBe("This moves real funds between chains. It cannot be undone.");
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
    // Outside the four families the eyebrow is the tool's own title.
    expect(document.querySelector(".vex-appr__eyebrow")?.textContent).toBe("WalletEvmTransactionConfirm");
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

  it("keeps the same data: send, receive, minimum, and the fees on Cloud's two rows (DG5-06)", () => {
    renderCard(SWAP, false);
    const rows = moneyRows();
    expect(rows.map((row) => row.label)).toEqual(["You send", "You receive", "Minimum receipt", "Fees", "Network fee"]);
    expect(rows[0]?.value).toBe("200 USDC · on Base");
    expect(rows[1]?.value).toBe("0.05714 ETH · quoted");
    expect(rows[2]?.value).toBe("0.05686 ETH · slippage limit 0.5%");
    expect(rows[3]?.value).toBe("Vex fee 0.5 USDC (0.25%)");
    expect(rows[4]?.value).toBe("Not available");
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
    expect(label).toContain("padding-left: var(--vex-appr-inset)");
    expect(label).toContain("color: var(--vex-alias-label-tertiary)");
    // The register owns the label's face and caps; the row never overrides them.
    expect(label).not.toMatch(/font-family|font-size|text-transform|letter-spacing/);
    // The card sets the register at Cloud's card measure, mono 12 at 0.06em, in one place.
    const measure = ruleBody(".vex-appr .vex-field-label");
    expect(measure).toContain("font-size: 12px");
    expect(measure).toContain("letter-spacing: 0.06em");
    const value = ruleBody(".vex-appr__dl dd");
    expect(value).toContain("text-align: right");
    expect(value).toContain("padding-right: var(--vex-appr-inset)");
    expect(value).toContain("font-size: 13px");
    expect(ruleBody(".vex-appr__num")).toContain("font-size: 12px");
  });

  describe("All signed fields, H3's disclosure", () => {
    function signed(): HTMLDetailsElement {
      const details = screen.getByText("All signed fields").closest("details");
      expect(details).not.toBeNull();
      return details as HTMLDetailsElement;
    }

    it("is one key row: the chevron, the words in sentence case, and what it folds", () => {
      renderCard(SWAP, false);
      const key = signed().querySelector("summary");
      expect(key?.className).toBe("vex-appr__more-key");
      expect(key?.firstElementChild?.className).toBe("vex-appr__chev");
      expect(key?.querySelector(".vex-appr__more-sum")?.textContent).toBe(
        "kyberswap:swap.execute, wallet broadcast, raw arguments",
      );
      // Closed while the table above has facts to read.
      expect(signed().open).toBe(false);
    });

    it("folds the same signed record as before, every field and the tool exactly as bound", () => {
      renderCard(SWAP, false);
      const details = signed();
      const args = screen.getByTestId("critical-args");
      expect(details.contains(args)).toBe(true);
      expect(details.contains(screen.getByTestId("approval-proposal"))).toBe(true);
      expect(details.contains(screen.getByTestId("action-chip"))).toBe(true);
      const keys = Array.from(args.querySelectorAll("dt")).map((dt) => dt.textContent);
      // Keys as bound (the Vex fee keeps its one human label), never re-cased.
      expect(keys).toEqual([
        "toolId",
        "chain",
        "tokenIn",
        "tokenOut",
        "amountIn",
        "slippageBps",
        "Vex fee",
        "quoteBinding",
      ]);
      for (const dt of Array.from(details.querySelectorAll("dt"))) {
        expect(dt.classList.contains("vex-field-label")).toBe(false);
      }
      expect(details.textContent).toContain("kyberswap:swap.execute");
    });

    it("sets the key in caps and tracked sans 13, ruled like a row, its note in sentence case", () => {
      const key = ruleBody(".vex-appr__more-key");
      expect(key).toContain("font-size: 13px");
      expect(key).toContain("text-transform: uppercase");
      expect(key).toContain("letter-spacing: var(--tracking-label)");
      expect(key).toContain("border-top: 1px solid var(--vex-alias-rule)");
      expect(key).toContain("padding: 0 var(--vex-appr-inset)");
      expect(key).toContain("min-height: 34px");
      // Ink, not the old blue link: blue is for the primary key only.
      expect(key).toContain("color: var(--vex-alias-label-primary)");
      expect(key).not.toContain("accent");
      const note = ruleBody(".vex-appr__more-sum");
      expect(note).toContain("text-transform: none");
      expect(note).toContain("letter-spacing: normal");
      // H3's focus: the 2px ring inside the cell.
      expect(ruleBody(".vex-appr__more-key:focus-visible")).toContain("outline-offset: -2px");
    });

    it("rules every open field edge to edge, its key in mono and never in caps", () => {
      const cell = ruleBody(".vex-appr__well dt,\n.vex-appr__well dd");
      expect(cell).toContain("border-top: 1px solid var(--vex-alias-rule)");
      const key = ruleBody(".vex-appr__well dt");
      expect(key).toContain("font-family: var(--font-mono)");
      expect(key).toContain("padding-left: var(--vex-appr-inset)");
      expect(key).not.toContain("text-transform");
      expect(ruleBody(".vex-appr__well dd")).toContain("padding-right: var(--vex-appr-inset)");
    });
  });
});

/**
 * EVERY KIND IN THE SAME FRAME (row S6b-06). The card serves every tool
 * family, and each wears the one H3 frame: the head with its family's eyebrow,
 * MAINNET and the stamp wherever funds can move, the consequence line only
 * where it is true, the table in the field-label register, the folded signed
 * fields, and its own action-named key. The decision stays the card's own: the
 * second press arms exactly where `isHighRisk` says, kind by kind, and the
 * second press is what sends the approval.
 */
describe("ApprovalCard, every kind in the same frame", () => {
  const ORDER_LINE = "This places a real order on mainnet. It cannot be undone.";
  const RESTING_LINE = "This places a real order on mainnet.";
  const TRANSFER_LINE = "This sends real funds on mainnet. A transfer cannot be reversed.";
  const BRIDGE_LINE = "This moves real funds between chains. It cannot be undone.";
  const ADDRESS = "0x9a3c5f1e2d4b6a8c0e1f3a5b7c9d0e2f4a6b8c0d";

  interface Kind {
    readonly name: string;
    readonly summary: ApprovalSummaryDto;
    readonly eyebrow: string;
    readonly approve: string;
    readonly consequence: string | null;
    readonly realFunds: boolean;
    readonly twoPress: boolean;
  }

  const lighter = (toolName: string, criticalArgs: Record<string, string | number | boolean | null>) => ({
    toolName,
    namespace: "lighter",
    criticalArgs,
  });

  const KINDS: readonly Kind[] = [
    {
      name: "a wallet send",
      summary: makeSummary({
        toolName: "WalletSendConfirm",
        preview: { toolName: "WalletSendConfirm", criticalArgs: { chain: "base", to: ADDRESS, amount: "25", token: "USDC" } },
      }),
      eyebrow: "Confirm this transfer",
      approve: "Approve transfer",
      consequence: TRANSFER_LINE,
      realFunds: true,
      twoPress: true,
    },
    {
      name: "a bridge",
      summary: makeSummary({ toolName: "BridgeExecute", preview: BRIDGE_PREVIEW }),
      eyebrow: "Confirm this bridge",
      approve: "Approve bridge",
      consequence: BRIDGE_LINE,
      realFunds: true,
      twoPress: true,
    },
    {
      name: "a Lighter limit order",
      summary: makeSummary({
        toolName: "lighter:order.create",
        actionKind: "external_post",
        riskLevel: "medium",
        preview: lighter("order.create", {
          toolId: "lighter.order.create",
          side: "buy",
          baseAmountDisplay: "0.0002",
          marketSymbol: "BTC",
          orderType: "limit",
          timeInForce: "good-till-time",
          priceDisplay: "68000.0",
        }),
      }),
      eyebrow: "Confirm this order",
      approve: "Approve order",
      // It rests on the book and can be cancelled before it fills.
      consequence: RESTING_LINE,
      realFunds: true,
      twoPress: false,
    },
    {
      name: "a Lighter market order",
      summary: makeSummary({
        toolName: "lighter:order.create",
        actionKind: "external_post",
        riskLevel: "high",
        preview: lighter("order.create", {
          toolId: "lighter.order.create",
          side: "sell",
          baseAmountDisplay: "0.0002",
          marketSymbol: "BTC",
          orderType: "market",
          timeInForce: "immediate-or-cancel",
          priceDisplay: "67000.0",
        }),
      }),
      eyebrow: "Confirm this order",
      approve: "Approve order",
      consequence: ORDER_LINE,
      realFunds: true,
      twoPress: true,
    },
    {
      name: "a Lighter order cancel",
      summary: makeSummary({
        toolName: "lighter:order.cancel",
        actionKind: "external_post",
        riskLevel: "low",
        preview: lighter("order.cancel", { toolId: "lighter.order.cancel", providerOrderId: "7", marketIndex: 1 }),
      }),
      eyebrow: "Confirm this order",
      approve: "Approve order",
      consequence: null,
      realFunds: true,
      twoPress: false,
    },
    {
      name: "a Lighter deposit",
      summary: makeSummary({
        toolName: "lighter:deposit",
        preview: lighter("deposit", {
          toolId: "lighter.deposit",
          summary: "Deposit 100 USDC into your Lighter account",
          amountDisplay: "100 USDC",
          settlementNetworkName: "Arbitrum",
        }),
      }),
      eyebrow: "Confirm this transfer",
      approve: "Approve and deposit",
      consequence: TRANSFER_LINE,
      realFunds: true,
      twoPress: true,
    },
    {
      name: "a Lighter withdrawal",
      summary: makeSummary({
        toolName: "lighter:withdraw",
        actionKind: "external_post",
        riskLevel: "high",
        preview: lighter("withdraw", {
          toolId: "lighter.withdraw",
          summary: "Withdraw 40 USDC to your wallet",
          amountDisplay: "40 USDC",
          destinationAddress: ADDRESS,
        }),
      }),
      eyebrow: "Confirm this transfer",
      approve: "Approve transfer",
      consequence: TRANSFER_LINE,
      realFunds: true,
      twoPress: true,
    },
    {
      name: "the Lighter trading-fee authorization",
      summary: makeSummary({
        toolName: "lighter:fees.approve",
        riskLevel: "medium",
        preview: lighter("fees.approve", {
          toolId: "lighter.fees.approve",
          summary: "Authorize VEX trading fees",
          revoke: false,
          perpetualFee: "0.02%",
        }),
      }),
      eyebrow: "Lighter · Fees approve",
      approve: "Approve trading fees",
      consequence: null,
      realFunds: true,
      twoPress: true,
    },
    {
      name: "a token launch asked for over MCP",
      summary: makeSummary({
        toolName: "pools:launch_execute",
        origin: "studio_mcp",
        preview: {
          toolName: "launch_execute",
          namespace: "pools",
          criticalArgs: { toolId: "pools.launch_execute", name: "Harbor Token", symbol: "HRBR", pairedAsset: "weth" },
        },
      }),
      eyebrow: "pools.fun · Launch",
      approve: "Approve",
      consequence: null,
      realFunds: true,
      twoPress: true,
    },
    {
      name: "a call to the user's own MCP tool",
      summary: makeSummary({
        toolName: "mcp:deepwiki / read_wiki_structure",
        actionKind: "read",
        riskLevel: "info",
        preview: {
          toolName: "deepwiki / read_wiki_structure",
          namespace: "mcp",
          criticalArgs: { server: "deepwiki", tool: "read_wiki_structure", arguments: "{}" },
        },
      }),
      eyebrow: "Deepwiki / read wiki structure",
      approve: "Approve",
      consequence: null,
      realFunds: false,
      twoPress: false,
    },
    {
      name: "a generic signed transaction",
      summary: makeSummary({
        toolName: "WalletEvmTransactionConfirm",
        preview: { toolName: "WalletEvmTransactionConfirm", criticalArgs: { chain: "base", recipient: ADDRESS } },
      }),
      eyebrow: "WalletEvmTransactionConfirm",
      approve: "Approve",
      consequence: null,
      realFunds: true,
      twoPress: true,
    },
  ];

  const card = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[data-vex-area="approval-card"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  };

  it.each(KINDS)("draws $name in the H3 frame with its own eyebrow and key", (kind) => {
    renderCard(kind.summary, false);
    const frame = card();
    expect(frame.classList.contains("vex-appr")).toBe(true);
    expect(frame.getAttribute("data-vex-approval-layout")).toBe("card");
    const head = frame.querySelector(".vex-appr__head");
    expect(head?.querySelector("header .vex-appr__eyebrow")?.textContent).toBe(kind.eyebrow);
    expect(head?.contains(screen.getByRole("heading", { level: 3 }))).toBe(true);
    expect(screen.getByRole("button", { name: kind.approve })).toBeTruthy();
    // Reject is the same key on every kind.
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByText("All signed fields").closest("details")).not.toBeNull();
  });

  it.each(KINDS)("states the consequence for $name only where it is true", (kind) => {
    renderCard(kind.summary, false);
    const line = screen.queryByTestId("approval-consequence");
    if (kind.consequence === null) expect(line).toBeNull();
    else expect(line?.textContent).toBe(kind.consequence);
  });

  it.each(KINDS)("carries MAINNET and REAL FUNDS on $name exactly when funds can move", (kind) => {
    renderCard(kind.summary, false);
    const header = card().querySelector("header");
    const stamp = screen.queryByTestId("real-funds-stamp");
    const network = screen.queryByTestId("approval-network");
    if (kind.realFunds) {
      expect(header?.contains(stamp)).toBe(true);
      expect(network?.textContent).toBe("Mainnet");
    } else {
      expect(stamp).toBeNull();
      expect(network).toBeNull();
    }
  });

  it.each(KINDS)("sets $name's readable rows in the field-label register", (kind) => {
    renderCard(kind.summary, false);
    const table = card().querySelector<HTMLElement>(".vex-appr__head ~ .vex-appr__dl");
    if (table === null) {
      // No readable rows: the signed fields stand open instead, never folded away.
      expect(screen.getByText("All signed fields").closest("details")?.open).toBe(true);
      return;
    }
    const labels = Array.from(table.querySelectorAll("dt"));
    expect(labels.length).toBeGreaterThan(0);
    for (const dt of labels) expect(dt.classList.contains("vex-field-label")).toBe(true);
  });

  it.each(KINDS)("keeps $name's decision as it was: the second press arms only where it always has", (kind) => {
    renderCard(kind.summary, false);
    fireEvent.click(screen.getByRole("button", { name: kind.approve }));
    if (kind.twoPress) {
      expect(mockApproveMutate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /confirm approve/i }));
    }
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).toHaveBeenCalledWith({ id: "appr-1" }, expect.any(Object));
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });

  it("gives every cell one inset, H3's 24, set once on the card", () => {
    const sheet = readFileSync(join(process.cwd(), "src/renderer/styles/global-css/approval.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sheet).toMatch(/\.vex-appr \{[^}]*--vex-appr-inset: 24px;/);
    // No cell spells the inset itself, so a narrow host changes one length.
    expect(sheet).not.toMatch(/(?:padding|margin)(?:-left|-right)?:[^;]*\b24px/);
  });

  it("narrows the Lighter desk's Review order card through the one inset, its rules still edge to edge", () => {
    const desk = readFileSync(join(process.cwd(), "src/renderer/styles/global-css/lighter-ticket.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(desk).toMatch(/\.lit-order-review \.vex-appr \{[^}]*--vex-appr-inset: 14px;/);
    // The cells own the inset, so the card's own padding would only add to it.
    expect(desk).toMatch(/\.lit-order-review \.vex-appr__in \{\s*padding: 0;\s*\}/);
    // The table's rows keep their inline inset; the desk only tightens the block.
    const rows = /\.lit-order-review \.vex-appr__dl dt,\s*\.lit-order-review \.vex-appr__dl dd \{([^}]*)\}/.exec(desk)?.[1] ?? "";
    expect(rows).toContain("padding-block: 5px");
    expect(rows).not.toMatch(/padding:\s/);
  });

  it("holds MAINNET and the stamp together as one unit of the eyebrow row", () => {
    renderCard(KINDS[0]?.summary ?? makeSummary(), false);
    const network = screen.getByTestId("approval-network");
    const stamp = screen.getByTestId("real-funds-stamp");
    expect(network.parentElement).toBe(stamp.parentElement);
    expect(network.parentElement?.className).toBe("vex-appr__funds");
  });
});

/**
 * THE DECISION ROW IN THE SHELL'S BOTTOM ROW (row S6b-05, H3-DESKTOP.md
 * sections 1.8 and 4.3). Given the chat's dock, the card draws its footer
 * there: the reason field, Reject, the gate line, the approve key. It is the
 * same footer with the same state, so every gate the card keeps inside itself
 * holds docked too, and these cases press the docked keys to prove it.
 */
describe("ApprovalCard, its decision row docked in the shell's bottom row", () => {
  let dock: HTMLElement;
  beforeEach(() => {
    document.querySelectorAll("[data-test-dock]").forEach((node) => node.remove());
    dock = document.createElement("div");
    dock.setAttribute("data-test-dock", "");
    document.body.appendChild(dock);
  });

  function renderDocked(summary: ApprovalSummaryDto, focusOnMount = false): void {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalCard summary={summary} sessionId={SESSION} focusOnMount={focusOnMount} decisionDock={dock} />
      </QueryClientProvider>,
    );
  }
  const card = (): HTMLElement => document.querySelector<HTMLElement>('[data-vex-area="approval-card"]') as HTMLElement;
  const foot = (): HTMLElement => dock.querySelector<HTMLElement>('[data-vex-area="approval-foot"]') as HTMLElement;

  it("moves the footer out of the card into the dock, named by the card's title", () => {
    renderDocked(makeSummary());
    expect(card().hasAttribute("data-vex-decision-docked")).toBe(true);
    expect(card().querySelector('[data-vex-area="approval-foot"]')).toBeNull();
    expect(foot()).not.toBeNull();
    expect(foot().hasAttribute("data-docked")).toBe(true);
    expect(foot().getAttribute("role")).toBe("group");
    const title = screen.getByRole("heading", { level: 3 });
    expect(foot().getAttribute("aria-labelledby")).toBe(title.id);
  });

  it("orders the cells as H3 does: the reason field, Reject, the gate line, the approve key", () => {
    renderDocked(makeSummary());
    const cells = Array.from(foot().children).map((child) =>
      child.getAttribute("data-vex-key") ?? child.getAttribute("data-vex-area") ?? child.tagName.toLowerCase(),
    );
    expect(cells).toEqual(["input", "reject", "approval-gate", "approve"]);
    expect(screen.getByLabelText(REJECT_REASON_LABEL).getAttribute("placeholder")).toBe(REJECT_REASON_PLACEHOLDER);
  });

  it("says the gate in the middle cell: two presses on a high-risk card, one elsewhere", () => {
    renderDocked(makeSummary());
    expect(dock.querySelector('[data-vex-area="approval-gate"]')?.textContent).toBe(
      "Two presses decide: the first arms the key for 4 s.",
    );
  });

  it("says nothing signs until you approve on a card that decides on one press", () => {
    renderDocked(makeSummary({ riskLevel: "info", actionKind: "read" }));
    expect(dock.querySelector('[data-vex-area="approval-gate"]')?.textContent).toBe("Nothing signs until you approve.");
  });

  it("keeps the two-step confirm on a high-risk card: the first press arms, the second sends", () => {
    renderDocked(makeSummary());
    fireEvent.click(screen.getByRole("button", { name: "Approve transfer" }));
    expect(mockApproveMutate).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: /confirm approve/i });
    expect(dock.contains(armed)).toBe(true);
    expect(armed.hasAttribute("data-armed")).toBe(true);
    expect(armed.textContent).toContain("Click again to confirm approve");
    fireEvent.click(armed);
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).toHaveBeenCalledWith({ id: "appr-1" }, expect.any(Object));
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });

  it("keeps the two-press Reject, and the reason travels with Reject", () => {
    renderDocked(makeSummary());
    fireEvent.change(screen.getByLabelText(REJECT_REASON_LABEL), { target: { value: "Use 100 USDC instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(mockRejectMutate).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: /confirm reject/i });
    expect(armed.textContent).toBe("Click again to confirm reject");
    fireEvent.click(armed);
    expect(mockRejectMutate).toHaveBeenCalledWith(
      { id: "appr-1", reason: "Use 100 USDC instead" },
      expect.any(Object),
    );
    expect(mockApproveMutate).not.toHaveBeenCalled();
  });

  it("never lets the reason ride along with an approve", () => {
    renderDocked(makeSummary({ riskLevel: "info", actionKind: "read" }));
    fireEvent.change(screen.getByLabelText(REJECT_REASON_LABEL), { target: { value: "ignored" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve transfer" }));
    expect(mockApproveMutate).toHaveBeenCalledWith({ id: "appr-1" }, expect.any(Object));
  });

  it("decides a low-risk card on one press, as before", () => {
    renderDocked(makeSummary({ riskLevel: "info", actionKind: "read" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: "appr-1" }, expect.any(Object));
  });

  it("gives the docked Reject the first focus", () => {
    renderDocked(makeSummary(), true);
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(dock.contains(reject)).toBe(true);
    expect(document.activeElement).toBe(reject);
  });

  it("locks both docked keys while a decision is in flight", () => {
    approvePending = true;
    renderDocked(makeSummary());
    for (const key of Array.from(foot().querySelectorAll("button"))) expect(key.disabled).toBe(true);
    expect(foot().querySelector('[data-vex-key="approve"]')?.hasAttribute("data-vex-approve-working")).toBe(true);
  });

  it("keeps the footer in the card when no dock is given, as on every other surface", () => {
    renderCard(makeSummary(), false);
    expect(card().hasAttribute("data-vex-decision-docked")).toBe(false);
    const inCard = card().querySelector('[data-vex-area="approval-foot"]');
    expect(inCard).not.toBeNull();
    expect(inCard?.hasAttribute("data-docked")).toBe(false);
    expect(inCard?.querySelector('[data-vex-area="approval-gate"]')).toBeNull();
    expect(dock.childElementCount).toBe(0);
  });

  describe("the docked row's sheet", () => {
    const sheet = readFileSync(join(process.cwd(), "src/renderer/styles/global-css/approval.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
      expect(match, `rule missing: ${selector}`).not.toBeNull();
      return match?.[1] ?? "";
    };

    it("hides the composer while the dock holds a decision, and only then", () => {
      expect(rule("[data-vex-composer-dock]:has(+ .vex-appr-dock:not(:empty))")).toContain("display: none");
      expect(rule(".vex-appr-dock:empty")).toContain("display: none");
    });

    it("lays the row out as H3's cells: the reason across, then Reject 168 | the gate | approve 200, 72 high", () => {
      const row = rule(".vex-appr__foot[data-docked]");
      expect(row).toContain("grid-template-columns: 168px minmax(0, 1fr) 200px");
      expect(row).toContain('"reason reason reason"');
      expect(row).toContain('"reject gate approve"');
      expect(row).toContain("position: static");
      expect(rule(".vex-appr__foot[data-docked] > button")).toContain("height: var(--vex-h3-bottom-h)");
      expect(rule(".vex-appr__foot[data-docked] > input")).toContain("font-size: 18px");
      // Cloud's keys: 13 caps, the approve key 32 each side of its word.
      expect(rule(".vex-appr__foot[data-docked] > button")).toContain("font-size: 13px");
      expect(rule('.vex-appr__foot[data-docked] > [data-vex-key="approve"]')).toContain("padding: 0 32px");
    });

    it("fills Reject raised and the approve key blue, an armed key in reversed ink and never a second blue", () => {
      expect(rule('.vex-appr__foot[data-docked] > [data-vex-key="reject"]')).toContain(
        "background: var(--vex-alias-interactive-solid)",
      );
      expect(rule('.vex-appr__foot[data-docked] > [data-vex-key="approve"]')).toContain(
        "background: var(--vex-alias-button-accent-fill)",
      );
      const armed = rule(
        ".vex-appr__foot[data-docked] > button[data-armed],\n.vex-appr__foot[data-docked] > button[data-armed]:enabled:hover",
      );
      expect(armed).toContain("background: var(--vex-alias-rule-ink)");
      expect(armed).not.toContain("accent");
      expect(rule(".vex-appr__foot[data-docked] > button:focus-visible")).toContain("outline-offset: -2px");
    });
  });
});
