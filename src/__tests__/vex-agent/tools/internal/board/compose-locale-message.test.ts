/**
 * Pins the MODEL-FACING wording of an over-limit `notes` array on the exact
 * path BoardCompose uses (`boardComposeInputSchema.safeParse` ->
 * `formatZodIssuesForModel`, src/vex-agent/tools/internal/board/compose.ts).
 *
 * Measured defect (2026-08-26): 32 stored tool outputs read
 * `BoardCompose: notes: Invalid input (received a list)` when the real cause
 * was an array over `BOARD_MAX_NOTES`. zod's English locale had been
 * tree-shaken out of the bundled main process, so every issue degraded to
 * zod core's generic `"Invalid input"`. This test asserts the message names
 * the constraint the model has to fix.
 *
 * It cannot fail from tree-shaking (vitest does not tree-shake); the built
 * bundles are covered by the postbuild gate in
 * vex-app/scripts/check-privileged-bundles.mjs. What it DOES catch is a change
 * to the schema, the formatter, or the locale wiring that takes the specific
 * wording away again.
 *
 * Fixture text is synthetic, shaped like the archived failing call: no owner
 * data.
 */

import { describe, expect, it } from "vitest";
import { BOARD_MAX_NOTES, boardComposeInputSchema } from "../../../../../lib/board/spec.js";
import { formatZodIssuesForModel } from "../../../../../vex-agent/tools/internal/arg-validation.js";

/** One note per index, synthetic, well inside the per-note character rule. */
function syntheticNotes(count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `Synthetic analysis note number ${index + 1} for the locale regression fixture.`,
  );
}

const overLimitArgs = {
  title: "Locale regression fixture board",
  pools: [
    {
      chain: "ethereum",
      pairAddress: "0x0000000000000000000000000000000000000001",
      caption: "Synthetic pool caption.",
      analysis: null,
    },
  ],
  notes: syntheticNotes(BOARD_MAX_NOTES + 1),
};

describe("BoardCompose over-limit notes message", () => {
  it("names the array bound instead of zod core's generic 'Invalid input'", () => {
    const parsed = boardComposeInputSchema.safeParse(overLimitArgs);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const message = formatZodIssuesForModel(parsed.error.issues, overLimitArgs);

    expect(message).toContain("notes");
    expect(message).toContain("expected array to have");
    expect(message).toContain(String(BOARD_MAX_NOTES));
    expect(message).not.toContain("Invalid input");
  });

  it("accepts exactly BOARD_MAX_NOTES notes, so the bound itself is unchanged", () => {
    const parsed = boardComposeInputSchema.safeParse({
      ...overLimitArgs,
      notes: syntheticNotes(BOARD_MAX_NOTES),
    });
    expect(parsed.success).toBe(true);
  });
});
