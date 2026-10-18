/**
 * ComposerQuickActions - the welcome's task rows under the composer
 * (docs/design/R3-MINIMAL.md section 7, reference d2). Pins the R3 contract:
 * four task-first rows in the design's order, each a blue line icon and its
 * label; a prompt row seeds the draft with its full prompt, and "Create a
 * mission" opens the new session form instead of seeding a chat message.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ComposerQuickActions } from "../ComposerQuickActions.js";
import { QUICK_ACTIONS } from "../composer-quick-actions.js";

function renderRows(
  onPick: (prompt: string) => void = () => {},
  onCreateMission: () => void = () => {},
) {
  return render(
    <ComposerQuickActions onPick={onPick} onCreateMission={onCreateMission} />,
  );
}

describe("ComposerQuickActions", () => {
  it("renders the four task rows in the design's order, each an icon and its label", () => {
    renderRows();
    const rows = screen.getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Check wallet balances",
      "Review the market",
      "Create a mission",
      "Trade perps on Lighter",
    ]);
    for (const row of rows) {
      // The icon is decoration: hidden from assistive tech, the label names
      // the row.
      const icon = row.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.getAttribute("class")).toContain("vex-starter__icon");
    }
  });

  it("draws plain ruled rows - no band behind the list, no rounded box, no numbering", () => {
    const { container } = renderRows();
    const root = container.firstElementChild;
    expect(root?.className).not.toMatch(/bg-|backdrop-blur|rounded/);
    const row = root?.querySelector("button");
    expect(row?.className).toBe("vex-starter");
    expect(container.textContent).not.toMatch(/\b0[1234]\b/);
  });

  it("the Lighter row seeds the typed desk command, so Send opens the desk", () => {
    const onPick = vi.fn();
    renderRows(onPick);
    fireEvent.click(screen.getByRole("button", { name: /trade perps on lighter/i }));
    expect(onPick).toHaveBeenCalledWith("Light it up.");
  });

  it("seeds the draft with the row's full prompt", () => {
    const onPick = vi.fn();
    renderRows(onPick);
    fireEvent.click(screen.getByRole("button", { name: /check wallet balances/i }));
    expect(onPick).toHaveBeenCalledWith(
      QUICK_ACTIONS.find((action) => action.label === "Check wallet balances")?.prompt,
    );
    fireEvent.click(screen.getByRole("button", { name: /review the market/i }));
    expect(onPick).toHaveBeenLastCalledWith(
      QUICK_ACTIONS.find((action) => action.label === "Review the market")?.prompt,
    );
  });

  it("Create a mission opens the new session form and seeds no chat message", () => {
    const onPick = vi.fn();
    const onCreateMission = vi.fn();
    renderRows(onPick, onCreateMission);
    fireEvent.click(screen.getByRole("button", { name: /create a mission/i }));
    expect(onCreateMission).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("every prompt row carries a full-sentence prompt; the mission row carries none", () => {
    for (const action of QUICK_ACTIONS) {
      if (action.kind === "mission") {
        expect(action.prompt).toBe("");
      } else {
        expect(action.prompt.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
