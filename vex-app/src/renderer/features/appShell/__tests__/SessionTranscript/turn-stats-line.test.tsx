/**
 * TurnStatsLine REGISTER (owner QA round 2, item 6: "88.1K IN / 554 OUT" was
 * illegible in chronos).
 *
 * The register was Doto, a dot-matrix face that laid down roughly half a solid
 * face's ink, so tiers calibrated for Inter Tight overstated its perceived
 * contrast. Doto retired on 2026-08-21 (owner decision 2) and the register is
 * now Inter Tight small-caps. The fix is the app-wide class plus a colour
 * tier at or above ink-secondary - never a per-spot patch, and never a size or
 * weight re-declaration at the call site (builder-C's `.vex-micro-label`
 * contract, board 2026-08-21).
 *
 * The pure grouping seams stay pinned in `./turnStats.test.ts`.
 */

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
  it("rides the shared micro-label class and the legible ink tier", () => {
    useLastTurnUsage.mockReturnValue(resolved(usage()));
    const { container } = render(
      createElement(TurnStatsLine, { sessionId: "s1" }),
    );
    const line = container.querySelector("[data-vex-turn-stats]");
    expect(line).not.toBeNull();
    expect(line?.className).toContain("vex-micro-label");
    // The retired per-spot register (11px / w500 / label-tertiary) is gone.
    expect(line?.className).not.toContain("vex-stat-doto");
    expect(line?.className).toContain("text-ink-secondary");
    // Colour is the call site's, but the receding tiers are a red build on a
    // micro label - they are the illegibility the owner reported.
    expect(line?.className).not.toContain("text-ink-tertiary");
    expect(line?.className).not.toContain("text-ink-caption");
    // Size, weight, tracking and tabular-nums belong to the class alone.
    for (const redeclared of ["text-[11px]", "text-[12px]", "font-medium", "tracking-["]) {
      expect(line?.className).not.toContain(redeclared);
    }
    // These are VALUES, not an eyebrow: no uppercase at the call site.
    expect(line?.className).not.toContain("uppercase");
  });

  it("paints the separator dot in a tier that is actually visible", () => {
    useLastTurnUsage.mockReturnValue(resolved(usage({ latestRoundCachedTokens: 44_050 })));
    const { container } = render(
      createElement(TurnStatsLine, { sessionId: "s1" }),
    );
    const dots = container.querySelectorAll('[aria-hidden][class*="rounded-[1px]"]');
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot.className).toContain("bg-line-3");
      // caption is the disabled/decoration tier; a 2px dot in it disappears.
      expect(dot.className).not.toContain("bg-ink-caption");
    }
  });

  it("stays in the assistant gutter with the rest of the pl-9 family", () => {
    useLastTurnUsage.mockReturnValue(resolved(usage()));
    const { container } = render(
      createElement(TurnStatsLine, { sessionId: "s1" }),
    );
    expect(
      container.querySelector("[data-vex-turn-stats]")?.className,
    ).toContain("pl-9");
  });

  it("renders nothing when there is no settled turn to report", () => {
    useLastTurnUsage.mockReturnValue(resolved(null));
    const { container } = render(
      createElement(TurnStatsLine, { sessionId: "s1" }),
    );
    expect(container.innerHTML).toBe("");
  });
});
