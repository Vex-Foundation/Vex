/**
 * Remove and Export session dialogs, R3 (docs/design/R3-MINIMAL.md section
 * 12): the destructive confirm blocks behind the flat paper scrim and the
 * export consent is a panel with no scrim; both keep first focus on the safe
 * choice, and a refused removal says so with the ink hatch swatch beside its
 * sentence.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { SessionDeleteDialog } from "../SessionDeleteDialog.js";
import { SessionExportDialog } from "../SessionExportDialog.js";

const ROW: SessionListItem = {
  id: "s1",
  mode: "mission",
  permission: "restricted",
  title: "Arbitrum LP Rebalance",
  initialGoal: null,
  startedAt: "2026-07-12T10:00:00.000Z",
  endedAt: null,
  missionStatus: "running",
  pinnedAt: null,
};

describe("SessionDeleteDialog", () => {
  it("blocks behind the scrim, leads with Cancel and offers Remove as the ink key", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(
      <SessionDeleteDialog
        session={ROW}
        blockedOutcome={null}
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = container.querySelector("dialog");
    expect(dialog?.getAttribute("data-vex-backdrop")).toBeNull();
    expect(screen.getByRole("heading", { name: "Remove session?" })).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.hasAttribute("autofocus")).toBe(true);
    expect(cancel.getAttribute("data-vex-button")).toBe("quiet");
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove.getAttribute("data-vex-button")).toBe("ink");
    expect(container.querySelector('[data-s="concerned"]')).toBeNull();

    fireEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a refused removal keeps the dialog open and draws the concerned swatch beside the sentence", () => {
    const { container } = render(
      <SessionDeleteDialog
        session={ROW}
        blockedOutcome="blocked_active_mission"
        pending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/this mission is still active/)).toBeTruthy();
    expect(container.querySelector('[data-s="concerned"]')).not.toBeNull();
  });
});

describe("SessionExportDialog", () => {
  it("is a panel with no scrim, Cancel first in focus, Export the one blue fill", () => {
    const { container } = render(
      <SessionExportDialog
        session={ROW}
        pending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(container.querySelector("dialog")?.getAttribute("data-vex-backdrop")).toBe("none");
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("autofocus")).toBe(true);
    expect(screen.getByRole("button", { name: "Export" }).getAttribute("data-vex-button")).toBe(
      "primary",
    );
    expect(screen.getByText(/Secrets are redacted automatically/)).toBeTruthy();
  });
});
