/**
 * TurnStatsLine REGISTER (docs/design/R3-MINIMAL.md section 6: "Turn stats
 * (11.5 muted) show on hover only").
 *
 * The line is VALUES ("88.1K in"), tabular, on the turn's 40px edge with the
 * rest of Vex's turn, revealed only when the turn or the line is hovered or
 * focused. Its metric and the reveal live in one class (`.vex-turn-stats`,
 * chat-transcript.css), never re-declared at the call site.
 *
 * The pure grouping seams stay pinned in `./turnStats.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { TurnStatsLine } from "../../SessionTranscript/TurnStatsLine.js";
import type { TurnUsageRollupDto } from "@shared/schemas/usage.js";

const useLastTurnUsage = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/usage.js", () => ({ useLastTurnUsage }));

function usage(over: Partial<TurnUsageRollupDto> = {}): TurnUsageRollupDto {
  return {
    latestRoundPromptTokens: 88_100,
    latestRoundCachedTokens: 0,
    turnCompletionTokens: 554,
    turnCost: 0.1493,
    roundCount: 1,
    currency: "USD",
    ...over,
  } as TurnUsageRollupDto;
}

/** The hook's success envelope; `data: null` = no settled turn to report. */
function resolved(data: TurnUsageRollupDto | null): unknown {
  return { data: { ok: true, data } };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("TurnStatsLine", () => {
  const CSS = readFileSync(
    join(process.cwd(), "src/renderer/styles/global-css/chat-transcript.css"),
    "utf8",
  );

  function ruleBody(selector: string, from = 0): string {
    const at = CSS.indexOf(`${selector} {`, from);
    expect(at, `rule missing: ${selector}`).toBeGreaterThan(-1);
    return CSS.slice(at, CSS.indexOf("}", at));
  }

  it("rides the one stats class on the turn's edge, never a per-spot register", () => {
    useLastTurnUsage.mockReturnValue(resolved(usage()));
    const { container } = render(
      createElement(TurnStatsLine, { sessionId: "s1" }),
    );
    const line = container.querySelector("[data-vex-turn-stats]");
    expect(line).not.toBeNull();
    expect(line?.className).toContain("vex-turn-stats");
    expect(line?.className).toContain("vex-turn");
    // Size, colour, tracking and case belong to the class alone; these are
    // VALUES, not an eyebrow.
    for (const redeclared of [
      "text-[11px]",
      "text-[12px]",
      "font-medium",
      "tracking-[",
      "uppercase",
      "font-mono",
      "vex-micro-label",
    ]) {
      expect(line?.className).not.toContain(redeclared);
    }
  });

  it("is 11.5 muted and tabular, on the 40px edge of Vex's turn", () => {
    const stats = ruleBody(".vex-turn-stats");
    expect(stats).toContain("font-size: 11.5px;");
    expect(stats).toContain("color: var(--vex-alias-label-tertiary);");
    expect(stats).toContain("font-variant-numeric: tabular-nums;");
    expect(ruleBody(".vex-turn")).toContain("padding-left: 40px;");
  });

  it("shows on hover or focus only, and always on touch", () => {
    const hover = CSS.indexOf("@media (hover: hover) {\n  .vex-turn-stats {");
    expect(hover).toBeGreaterThan(-1);
    const block = CSS.slice(hover, CSS.indexOf("\n}\n", hover));
    expect(block).toContain("opacity: 0;");
    expect(block).toContain(".vex-turn-stats:hover,");
    expect(block).toContain(".vex-turn-stats:focus-within,");
    // Hovering the turn itself (the row right above the line) reveals it.
    expect(block).toContain("[data-vex-entry-id]:hover + .vex-turn-stats {");
    // Outside the hover query nothing hides it, so touch keeps it visible.
    expect(ruleBody(".vex-turn-stats")).not.toContain("opacity");
  });

  it("separates its groups with the middle dot, as the design writes lists", () => {
    useLastTurnUsage.mockReturnValue(resolved(usage({ latestRoundCachedTokens: 44_050 })));
    const { container } = render(
      createElement(TurnStatsLine, { sessionId: "s1" }),
    );
    const dots = container.querySelectorAll("[data-vex-turn-stats] [aria-hidden]");
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot.textContent).toBe("\u00b7");
    }
  });

  it("renders nothing when there is no settled turn to report", () => {
    useLastTurnUsage.mockReturnValue(resolved(null));
    const { container } = render(
      createElement(TurnStatsLine, { sessionId: "s1" }),
    );
    expect(container.innerHTML).toBe("");
  });
});
