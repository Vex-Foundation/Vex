/**
 * ComposerQuickActions - the welcome's suggestions (docs/design/H3-DESKTOP.md
 * section 1.7 and Appendix A.4), H3's two-by-two grid of cells over the
 * composer. Pins H3's four in its order, each cell one key with its icon, its
 * title, its muted line (the prompt Send seeds) and the arrow; "Create a
 * mission" opens the new session form instead of seeding a chat message;
 * "Analyze BTC 4h" asks for what the technical analysis tool really does, and
 * no suggestion asks for a strategy.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const SHEET = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/composer.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** One rule's declarations by its exact selector. */
function rule(selector: string): string {
  const start = SHEET.indexOf(`\n${selector} {`);
  expect(start, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = SHEET.indexOf("{", start);
  return SHEET.slice(open + 1, SHEET.indexOf("}", open));
}

describe("ComposerQuickActions", () => {
  it("renders H3's four suggestions in its order, each key named by its title", () => {
    renderRows();
    const cells = screen.getAllByRole("button");
    expect(cells.map((cell) => cell.getAttribute("aria-labelledby") !== null)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      ["Check wallet balances", "Review the market", "Create a mission", "Analyze BTC 4h"].map(
        (name) => screen.getByRole("button", { name }),
      ),
    ).toEqual(cells);
  });

  it("each cell draws its icon, its title, its line and the arrow; the icon and the arrow are decoration", () => {
    renderRows();
    for (const action of QUICK_ACTIONS) {
      const cell = screen.getByRole("button", { name: action.label });
      expect(cell.querySelector(".vex-starter__title")?.textContent).toBe(action.label);
      expect(cell.querySelector(".vex-starter__line")?.textContent).toBe(action.line);
      const glyphs = Array.from(cell.querySelectorAll("svg"));
      expect(glyphs.map((svg) => svg.getAttribute("class"))).toEqual([
        expect.stringContaining("vex-starter__icon"),
        expect.stringContaining("vex-starter__arrow"),
      ]);
      for (const svg of glyphs) expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("describes each key by its line, so the title alone names it", () => {
    renderRows();
    for (const action of QUICK_ACTIONS) {
      const cell = screen.getByRole("button", { name: action.label });
      const lineId = cell.getAttribute("aria-describedby");
      expect(lineId).not.toBeNull();
      expect(document.getElementById(lineId ?? "")?.textContent).toBe(action.line);
    }
  });

  it("is a two-by-two grid of square ruled cells - no band, no rounded box, no numbering", () => {
    const { container } = renderRows();
    const root = container.firstElementChild;
    expect(root?.className).toBe("vex-starter-grid");
    expect(root?.className).not.toMatch(/bg-|backdrop-blur|rounded/);
    expect(root?.querySelector("button")?.className).toBe("vex-starter");
    expect(container.textContent).not.toMatch(/\b0[1234]\b/);
    const grid = rule(".vex-starter-grid");
    expect(grid).toMatch(/display:\s*grid;/);
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(grid).toMatch(/grid-auto-rows:\s*minmax\(113px, auto\);/);
    const cell = rule(".vex-starter");
    expect(cell).toMatch(/border-right:\s*1px solid var\(--vex-alias-rule\);/);
    expect(cell).toMatch(/border-bottom:\s*1px solid var\(--vex-alias-rule\);/);
    expect(cell).not.toMatch(/border-radius/);
  });

  it("sets the title in sans 16 ink and the line in sans 14 muted, 24 in", () => {
    expect(rule(".vex-starter__title")).toMatch(/font-size:\s*16px;/);
    expect(rule(".vex-starter__title")).toMatch(/color:\s*var\(--vex-alias-label-primary\);/);
    expect(rule(".vex-starter__line")).toMatch(/font-size:\s*14px;/);
    expect(rule(".vex-starter__line")).toMatch(/color:\s*var\(--vex-alias-label-tertiary\);/);
    expect(rule(".vex-starter")).toMatch(/padding:\s*18px 24px 20px;/);
    expect(rule(".vex-starters")).toMatch(/padding:\s*0 24px 34px;/);
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
