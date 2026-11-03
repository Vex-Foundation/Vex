/**
 * ComposerQuickActions - the welcome's suggestions (docs/design/H3-DESKTOP.md
 * Appendix A.4; drawn as R3's task rows under the composer,
 * docs/design/R3-MINIMAL.md section 7, until S6a-03). Pins H3's four in its
 * order, each a blue line icon and its label, with a muted line that is the
 * prompt Send seeds; "Create a mission" opens the new session form instead of
 * seeding a chat message; "Analyze BTC 4h" asks for what the technical
 * analysis tool really does, and no suggestion asks for a strategy.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ANALYSIS_INTERVALS } from "@vex-lib/market-analysis/result-schema.js";
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
  it("renders H3's four suggestions in its order, each an icon and its label", () => {
    renderRows();
    const rows = screen.getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Check wallet balances",
      "Review the market",
      "Create a mission",
      "Analyze BTC 4h",
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

  it("words each suggestion as Appendix A.4 does, its line the prompt Send seeds", () => {
    expect(QUICK_ACTIONS.map((action) => [action.label, action.line])).toEqual([
      ["Check wallet balances", "What's in my wallet?"],
      ["Review the market", "What's moving in crypto today, and why?"],
      ["Create a mission", "Start a mission: Vex drafts its contract and you accept it."],
      ["Analyze BTC 4h", "Analyze the BTC perpetual on Lighter on the 4h chart."],
    ]);
    for (const action of QUICK_ACTIONS) {
      if (action.kind === "prompt") expect(action.prompt, action.label).toBe(action.line);
    }
  });

  it("Analyze BTC 4h asks the analysis tool for a market and an interval it serves", () => {
    const onPick = vi.fn();
    renderRows(onPick);
    fireEvent.click(screen.getByRole("button", { name: /analyze btc 4h/i }));
    const prompt = onPick.mock.calls[0]?.[0] as string;
    expect(prompt).toBe("Analyze the BTC perpetual on Lighter on the 4h chart.");
    // Lighter's technical analysis reads one Lighter market at one of its
    // intervals; 4h is one of them.
    expect(ANALYSIS_INTERVALS as readonly string[]).toContain("4h");
    expect(prompt).toContain("4h");
    expect(prompt).toContain("Lighter");
    // No market the tool does not list: Lighter settles in USDC or USDG.
    expect(prompt).not.toMatch(/USDT/);
  });

  it("asks for no strategy and leaves the Lighter desk to the nav", () => {
    for (const action of QUICK_ACTIONS) {
      expect(`${action.label} ${action.line} ${action.prompt}`, action.label).not.toMatch(/strateg/i);
    }
    expect(QUICK_ACTIONS.some((action) => action.prompt === "Light it up.")).toBe(false);
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
