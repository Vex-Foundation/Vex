// @vitest-environment jsdom
/**
 * The approval Reject key names itself the initial focus WITHOUT the React
 * warning a lowercase `autofocus` prop logs ("Invalid DOM property
 * `autofocus`. Did you mean `autoFocus`?").
 *
 * The attribute is written by a ref (`useInitialFocusRef`), so the DOM is what
 * the prop used to produce: every host that finds the first focus by
 * `[autofocus]` (the Needs you page, the Needs you control, the Lighter desk
 * review, `DialogContent` after `showModal()`) still lands on Reject.
 */

import { createRef, type RefObject } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { ApprovalDecisionActions } from "../ApprovalCard/ApprovalDecisionActions.js";

function actions(rejectRef: RefObject<HTMLButtonElement | null>) {
  return (
    <ApprovalDecisionActions
      isHighRisk
      armedAction={null}
      inFlight={false}
      rejectRef={rejectRef}
      onReject={vi.fn()}
      onApprove={vi.fn()}
      rejectReason=""
      onRejectReasonChange={vi.fn()}
    />
  );
}

/** Every console.error line, flattened (React formats with %s placeholders). */
function logged(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
}

describe("ApprovalDecisionActions initial focus", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs no autofocus console error when the actions render", () => {
    render(actions(createRef<HTMLButtonElement>()));
    expect(logged(errorSpy).filter((line) => /autofocus/i.test(line))).toEqual([]);
    expect(logged(errorSpy).filter((line) => /Invalid DOM property/.test(line))).toEqual([]);
  });

  it("keeps the autofocus content attribute on Reject, and only on Reject", () => {
    const { container } = render(actions(createRef<HTMLButtonElement>()));
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject.hasAttribute("autofocus")).toBe(true);
    // The selector the Needs you page, the Needs you control and the desk
    // review use finds exactly that key.
    expect(
      container.querySelector<HTMLElement>(
        '[data-vex-area="approval-foot"] [autofocus]:not([disabled])',
      ),
    ).toBe(reject);
    expect(container.querySelectorAll("[autofocus]")).toHaveLength(1);
  });

  it("still hands the Reject node to the card's own rejectRef", () => {
    const rejectRef = createRef<HTMLButtonElement>();
    render(actions(rejectRef));
    expect(rejectRef.current).toBe(screen.getByRole("button", { name: "Reject" }));
  });

  it("is the first focus of a dialog that hosts the card", () => {
    render(
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>Review order</DialogTitle>
          <DialogDescription>Reject is the safer choice.</DialogDescription>
          {actions(createRef<HTMLButtonElement>())}
        </DialogContent>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reject" }));
    expect(logged(errorSpy).filter((line) => /autofocus/i.test(line))).toEqual([]);
  });

  it("detaches the ref on unmount", () => {
    const rejectRef = createRef<HTMLButtonElement>();
    const { unmount } = render(actions(rejectRef));
    expect(rejectRef.current).not.toBeNull();
    unmount();
    expect(rejectRef.current).toBeNull();
  });
});
