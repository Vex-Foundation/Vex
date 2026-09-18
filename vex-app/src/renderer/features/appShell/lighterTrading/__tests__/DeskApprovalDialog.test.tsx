// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalSummaryDto } from "../../../../../shared/schemas/approvals.js";
import { DeskApprovalDialog } from "../DeskApprovalDialog.js";

vi.mock("../../ApprovalCard.js", () => ({
  ApprovalCard: ({ summary }: { summary: { id: string } }) => (
    <div data-testid="approval-card">{summary.id}</div>
  ),
}));

function approval(id: string, toolName = "order.create"): ApprovalSummaryDto {
  return {
    id,
    sessionId: "00000000-0000-0000-0000-000000000001",
    toolCallId: null,
    toolName,
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-09-18T00:00:00.000Z",
    resolvedAt: null,
    reasoningPreview: "",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: { toolName, namespace: "lighter", criticalArgs: {} },
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: "desk",
    projectId: null,
    requestedByClient: null,
  };
}

const skip = { skipCloseConfirm: false, onSkipCloseConfirm: vi.fn() };

function dialogOf(container: HTMLElement): HTMLDialogElement {
  const node = container.querySelector("dialog[data-vex-area=lighter-desk-approval]");
  if (!(node instanceof HTMLDialogElement)) throw new Error("dialog missing");
  return node;
}

describe("DeskApprovalDialog", () => {
  it("opens with the pending cards and closes once none are left", () => {
    const { container, rerender } = render(
      <DeskApprovalDialog approvals={[approval("a1")]} sessionId="s1" focusApprovalId="a1" onResolved={vi.fn()} {...skip} />,
    );
    expect(dialogOf(container).open).toBe(true);
    expect(dialogOf(container).textContent).toContain("a1");
    expect(container.querySelector("dialog h2")?.textContent).toBe("Review order");
    rerender(<DeskApprovalDialog approvals={[]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} />);
    expect(dialogOf(container).open).toBe(false);
  });

  it("hides on Escape and comes back for a new card", () => {
    const { container, rerender } = render(
      <DeskApprovalDialog approvals={[approval("a1")]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} />,
    );
    fireEvent(dialogOf(container), new Event("cancel", { cancelable: true }));
    expect(dialogOf(container).open).toBe(false);
    rerender(
      <DeskApprovalDialog approvals={[approval("a1"), approval("a2")]} sessionId="s1" focusApprovalId="a2" onResolved={vi.fn()} {...skip} />,
    );
    expect(dialogOf(container).open).toBe(true);
    expect(dialogOf(container).textContent).toContain("a2");
  });

  it("reopens the same pending card when the ticket requests review", () => {
    const props = {
      approvals: [approval("a1")],
      sessionId: "s1",
      focusApprovalId: null,
      onResolved: vi.fn(),
      ...skip,
    };
    const { container, rerender } = render(<DeskApprovalDialog {...props} reopenSignal={0} />);
    fireEvent(dialogOf(container), new Event("cancel", { cancelable: true }));
    expect(dialogOf(container).open).toBe(false);

    rerender(<DeskApprovalDialog {...props} reopenSignal={1} />);
    expect(dialogOf(container).open).toBe(true);
    expect(dialogOf(container).textContent).toContain("a1");
  });

  it("offers Don't ask again only on a Market close card and reports the tick", () => {
    const onSkipCloseConfirm = vi.fn();
    const { container, rerender } = render(
      <DeskApprovalDialog
        approvals={[approval("a1")]}
        sessionId="s1"
        focusApprovalId="a1"
        onResolved={vi.fn()}
        skipCloseConfirm={false}
        onSkipCloseConfirm={onSkipCloseConfirm}
      />,
    );
    expect(container.querySelector(".lit-desk-skip-confirm")).toBeNull();

    rerender(
      <DeskApprovalDialog
        approvals={[approval("c1", "position.close")]}
        sessionId="s1"
        focusApprovalId="c1"
        onResolved={vi.fn()}
        skipCloseConfirm={false}
        onSkipCloseConfirm={onSkipCloseConfirm}
      />,
    );
    const box = container.querySelector<HTMLInputElement>(".lit-desk-skip-confirm input");
    if (!box) throw new Error("checkbox missing");
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onSkipCloseConfirm).toHaveBeenCalledWith(true);
    // The card that offered the box still waits for Confirm.
    expect(dialogOf(container).open).toBe(true);
    expect(container.querySelector("dialog h2")?.textContent).toBe("Review close");
  });

  it.each([
    ["order.cancel", "Review cancellation"],
    ["position.protect", "Review protection"],
  ])("names %s approvals", (toolName, title) => {
    const { container } = render(
      <DeskApprovalDialog approvals={[approval("a1", toolName)]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} />,
    );
    expect(container.querySelector("dialog h2")?.textContent).toBe(title);
  });

  it("names mixed approval cards as mixed actions", () => {
    const { container } = render(
      <DeskApprovalDialog approvals={[approval("a1"), approval("a2", "order.cancel")]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} />,
    );
    expect(container.querySelector("dialog h2")?.textContent).toBe("Review mixed actions");
  });
});
