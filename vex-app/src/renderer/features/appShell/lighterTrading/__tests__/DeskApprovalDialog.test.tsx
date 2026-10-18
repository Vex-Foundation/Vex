// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalSummaryDto } from "../../../../../shared/schemas/approvals.js";
import { DIALOG_INITIAL_FOCUS } from "../../../../components/ui/dialog.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { DeskApprovalDialog } from "../DeskApprovalDialog.js";
import { setDeskReviewSlot, useDeskReviewShowing } from "../desk-review-slot.js";

// The card's own safety flow (Reject first, the second press, the signing
// words) is ApprovalCard's and is pinned there; here the card is a stand-in
// that keeps the two facts the review relies on: its id and a Reject key
// named as the initial focus.
vi.mock("../../ApprovalCard.js", () => ({
  ApprovalCard: ({ summary }: { summary: { id: string } }) => (
    <section data-testid="approval-card" data-approval-id={summary.id}>
      {summary.id}
      <footer data-vex-area="approval-foot">
        <button type="button" {...DIALOG_INITIAL_FOCUS}>Reject {summary.id}</button>
      </footer>
    </section>
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
    preview: { toolName, namespace: "lighter", criticalArgs: toolName === "position.close" ? { baseAmount: "0.2500", positionAmount: "0.25" } : {} },
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
  beforeEach(() => {
    useLighterAnalysisStore.getState().saveDesk({ environment: "rhc" });
  });
  afterEach(() => {
    act(() => { setDeskReviewSlot(null); });
  });

  it("opens with the pending cards and closes once none are left", () => {
    const { container, rerender } = render(
      <DeskApprovalDialog approvals={[approval("a1")]} sessionId="s1" focusApprovalId="a1" onResolved={vi.fn()} {...skip} />,
    );
    expect(dialogOf(container).open).toBe(true);
    expect(dialogOf(container).classList.contains("lit-order-review")).toBe(true);
    expect(dialogOf(container).getAttribute("data-lighter-environment")).toBe("rhc");
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

  it("offers Don't ask again only on a full Market close card and reports the tick", () => {
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

  it.each(["0.1875", "0.125", "0.0625"])("keeps explicit confirmation for a partial %s close", (baseAmount) => {
    const full = approval("partial", "position.close");
    const partial = { ...full, preview: { toolName: "position.close", namespace: "lighter", criticalArgs: { baseAmount, positionAmount: "0.25" } } };
    const { container } = render(
      <DeskApprovalDialog approvals={[partial]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} skipCloseConfirm={true} />,
    );
    expect(dialogOf(container).open).toBe(true);
    expect(container.querySelector("dialog h2")?.textContent).toBe("Review close");
    expect(container.querySelector(".lit-desk-skip-confirm")).toBeNull();
  });

  it.each([
    ["order.cancel", "Review cancellation"],
    ["order.cancelAll", "Review account-wide cancellation"],
    ["position.protect", "Review protection"],
  ])("names %s approvals", (toolName, title) => {
    const { container } = render(
      <DeskApprovalDialog approvals={[approval("a1", toolName)]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} />,
    );
    expect(container.querySelector("dialog h2")?.textContent).toBe(title);
    expect(container.querySelector(".lit-desk-skip-confirm")).toBeNull();
  });

  it("names mixed approval cards as mixed actions", () => {
    const { container } = render(
      <DeskApprovalDialog approvals={[approval("a1"), approval("a2", "order.cancel")]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} />,
    );
    expect(container.querySelector("dialog h2")?.textContent).toBe("Review mixed actions");
  });
  it("presents inline in the ticket's slot, never as a modal, and tells the ticket to step aside", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    let showing = false;
    function ShowingProbe(): null {
      showing = useDeskReviewShowing();
      return null;
    }
    act(() => { setDeskReviewSlot(slot); });
    const { container, rerender } = render(
      <>
        <ShowingProbe />
        <DeskApprovalDialog approvals={[approval("a1")]} sessionId="s1" focusApprovalId="a1" onResolved={vi.fn()} {...skip} />
      </>,
    );
    const review = slot.querySelector<HTMLDialogElement>("dialog[data-vex-area=lighter-desk-approval]");
    if (review === null) throw new Error("review missing from the slot");
    expect(container.querySelector("dialog")).toBeNull();
    expect(review.open).toBe(true);
    expect(review.getAttribute("data-placement")).toBe("ticket");
    // Non-modal: an `open` attribute in the flow, no top layer and no veil.
    expect(review.matches(":modal")).toBe(false);
    expect(review.getAttribute("aria-labelledby")).toBe(review.querySelector("h2")?.id);
    expect(review.querySelector("h2")?.textContent).toBe("Review order");
    expect(showing).toBe(true);

    rerender(
      <>
        <ShowingProbe />
        <DeskApprovalDialog approvals={[]} sessionId="s1" focusApprovalId={null} onResolved={vi.fn()} {...skip} />
      </>,
    );
    expect(review.open).toBe(false);
    expect(showing).toBe(false);
    slot.remove();
  });

  it("gives the safe choice the first focus each time the review appears", () => {
    const props = { sessionId: "s1", onResolved: vi.fn(), ...skip };
    const { container, rerender } = render(
      <DeskApprovalDialog approvals={[approval("a1"), approval("a2")]} focusApprovalId="a2" {...props} reopenSignal={0} />,
    );
    expect(document.activeElement?.textContent).toBe("Reject a2");

    fireEvent.keyDown(dialogOf(container), { key: "Escape" });
    expect(dialogOf(container).open).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();

    rerender(<DeskApprovalDialog approvals={[approval("a1"), approval("a2")]} focusApprovalId={null} {...props} reopenSignal={1} />);
    expect(dialogOf(container).open).toBe(true);
    expect(document.activeElement?.textContent).toBe("Reject a1");
  });

  it("keeps Escape to itself, so the desk's own Escape keys do not also fire", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    const { container } = render(
      <DeskApprovalDialog approvals={[approval("a1")]} sessionId="s1" focusApprovalId="a1" onResolved={vi.fn()} {...skip} />,
    );
    fireEvent.keyDown(dialogOf(container), { key: "Escape" });
    window.removeEventListener("keydown", onWindowKey);
    expect(dialogOf(container).open).toBe(false);
    expect(onWindowKey).not.toHaveBeenCalled();
    // The card stays mounted while hidden: an armed key or a decision in
    // flight survives the trader looking away.
    expect(dialogOf(container).textContent).toContain("a1");
  });
});
