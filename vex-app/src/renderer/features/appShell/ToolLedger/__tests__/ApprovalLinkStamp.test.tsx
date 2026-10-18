/**
 * ApprovalLinkStamp tests (A3 — scoped focus).
 *
 * The same approval can render both inline (active session, inside
 * `[data-vex-area="session-panel"]`) and in the DESK RULE global inbox panel
 * (which precedes the session panel in document order). A ledger stamp-click
 * must always focus the INLINE card, never the header-panel copy — otherwise
 * an unscoped `document.querySelector` would grab the header copy first.
 */

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApprovalLinkStamp } from "../ApprovalLinkStamp.js";

describe("ApprovalLinkStamp", () => {
  it("focuses the inline session-panel card, not the header-panel copy", () => {
    render(
      <div>
        {/* Global header panel copy — earlier in document order. */}
        <div data-vex-area="global-approvals-panel">
          <div
            data-approval-id="appr-1"
            data-testid="panel-copy"
            tabIndex={-1}
          />
        </div>
        {/* Active session panel — hosts the stamp AND the inline card. */}
        <div data-vex-area="session-panel">
          <div
            data-approval-id="appr-1"
            data-testid="inline-copy"
            tabIndex={-1}
          />
          <ApprovalLinkStamp approvalId="appr-1" />
        </div>
      </div>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /waiting for approval/i }),
    );

    expect(document.activeElement).toBe(screen.getByTestId("inline-copy"));
    expect(document.activeElement).not.toBe(screen.getByTestId("panel-copy"));
  });

  it("falls back to a document-wide lookup when there is no session panel", () => {
    render(
      <div>
        <div data-approval-id="appr-2" data-testid="only-copy" tabIndex={-1} />
        <ApprovalLinkStamp approvalId="appr-2" />
      </div>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /waiting for approval/i }),
    );

    expect(document.activeElement).toBe(screen.getByTestId("only-copy"));
  });
});
