/**
 * Banner truthfulness — the CI half of the rules/07 prompt-contract change.
 *
 * A wrong word here fails no other test and silently degrades the agent every
 * turn at the most expensive moment. Three properties are pinned:
 *
 *   1. no output names a tool that no longer exists;
 *   2. the bypass shape does not claim the agent is blocked, because it is not;
 *   3. `compact_apply` is named only when it is actually in the catalog.
 *
 * The harness eval note (`agents_dm/runtime-harness/scenarios/`) covers the
 * qualitative side; this is the regression guard.
 */

import { describe, it, expect } from "vitest";
import { buildContextPressureBanner } from "../../../../vex-agent/engine/prompts/context-pressure.js";
import type { PreparationPressureState } from "../../../../vex-agent/engine/core/preparation-pressure-state.js";
import type { ContextUsageBand } from "../../../../vex-agent/engine/core/context-band.js";

const NONE: PreparationPressureState = { kind: "none" };
const READY: PreparationPressureState = { kind: "summary_ready", preparationId: "p1" };
const FAILED: PreparationPressureState = { kind: "failed", preparationId: "p1" };
const PREPARING: PreparationPressureState = {
  kind: "preparing",
  preparationId: "p1",
  leaseAlive: true,
  attemptsRemaining: 2,
  currentAttemptDeadlineMs: null,
};

const BANDS: ContextUsageBand[] = ["normal", "warning", "barrier", "critical"];
const STATES = [NONE, READY, FAILED, PREPARING];

/** Every banner the switch can produce. */
function allBanners(): string[] {
  const out: string[] = [];
  for (const band of BANDS) {
    for (const state of STATES) {
      out.push(buildContextPressureBanner(band, 0.9, state));
    }
  }
  return out;
}

describe("context-pressure banner — truthfulness", () => {
  it("NO output names a removed tool", () => {
    for (const banner of allBanners()) {
      expect(banner).not.toMatch(/compact_now/);
    }
  });

  it("NO output instructs the agent that it MUST call something", () => {
    // The runtime is the compaction mechanism now. A directive the agent cannot
    // satisfy produces a hallucinated call every turn.
    for (const banner of allBanners()) {
      expect(banner).not.toMatch(/MUST call/i);
      expect(banner).not.toMatch(/only allowed action/i);
    }
  });

  it("barrier WITH a live preparation: informational, never a block notice", () => {
    for (const state of [READY, PREPARING]) {
      const banner = buildContextPressureBanner("barrier", 0.9, state);
      expect(banner).toContain("full tool set remains available");
      expect(banner).not.toMatch(/blocked/i);
      expect(banner).not.toMatch(/unavailable/i);
    }
  });

  it("barrier WITHOUT a live preparation: says mutations are unavailable, truthfully", () => {
    for (const state of [NONE, FAILED]) {
      const banner = buildContextPressureBanner("barrier", 0.9, state);
      expect(banner).toContain("Mutating tools are unavailable");
      expect(banner).toContain("no tool call is required from you");
    }
  });

  it("a preparation with a DEAD lease gets the restrictive copy (matches the real gate)", () => {
    // The bypass is denied for this state, so the banner must not promise the
    // full tool set — banner and gate read the same predicate.
    const dead: PreparationPressureState = { ...PREPARING, leaseAlive: false };
    const banner = buildContextPressureBanner("barrier", 0.9, dead);
    expect(banner).toContain("Mutating tools are unavailable");
  });

  it("compact_apply is named ONLY when a summary is ready", () => {
    for (const band of BANDS) {
      for (const state of STATES) {
        const banner = buildContextPressureBanner(band, 0.9, state);
        if (state === READY && band !== "normal" && band !== "critical") {
          expect(banner).toContain("compact_apply");
        } else {
          expect(banner, `${band}/${state.kind}`).not.toContain("compact_apply");
        }
      }
    }
  });

  it("warning no longer promises the false '~88%' trigger", () => {
    const banner = buildContextPressureBanner("warning", 0.82, PREPARING);
    expect(banner).not.toContain("88%");
    expect(banner).toContain("prepares a compaction in the background");
  });

  it("normal band stays empty so the prompt layer is omitted entirely", () => {
    for (const state of STATES) {
      expect(buildContextPressureBanner("normal", 0.1, state)).toBe("");
    }
  });

  it("defaults to the no-preparation shape when no state is supplied", () => {
    // Callers that predate the axis must get the SAFE copy, not the bypass one.
    expect(buildContextPressureBanner("barrier", 0.9)).toContain(
      "Mutating tools are unavailable",
    );
  });

  it("every non-normal banner still reports the actual percentage", () => {
    for (const band of ["warning", "barrier", "critical"] as const) {
      expect(buildContextPressureBanner(band, 0.913, NONE)).toContain("91.3%");
    }
  });
});
