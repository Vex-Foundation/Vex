/**
 * THE ALWAYS-LOADED TOOL BLOCK, measured in bytes and pinned to a ceiling.
 *
 * `prompt-budget-ceiling.test.ts` pins the static PROMPT prefix. It does not
 * see this: `getOpenAITools` sends the internal tool definitions - name,
 * description and JSON schema - on EVERY provider request, before the model has
 * asked for anything, and that block is a second always-paid budget with no
 * gate over it. The Lighter integration is what made the gap expensive enough
 * to close: its two onboarding shortcuts joined the hot set (owner decision,
 * they stay), and their two descriptions and schemas are paid on every turn of
 * every session, including sessions that never mention Lighter.
 *
 * WHAT IS MEASURED. `toOpenAITools(getVisibleToolDefs(ctx))`, serialized as
 * JSON - the same projection `getOpenAITools` puts first in the tools array.
 * The injected protocol block is deliberately EXCLUDED: it varies with what the
 * session discovered through ToolSearch, it is the churn `getOpenAITools`
 * documents and accepts, and averaging it into a ceiling would hide the part
 * that is genuinely fixed.
 *
 * A REPORT WITH A CEILING, not a cap on authoring. Lower the ceiling whenever
 * an intentional change makes the block smaller. Raising it is a reviewed
 * budget decision with the same obligation as the prompt ceiling: itemize what
 * the bytes buy, and say why the cost belongs to this change rather than to a
 * tool that was already there.
 *
 * LEDGER
 *
 *  2026-09-07, Lighter integration. First measurement on this tree, so each
 *  ceiling is the measured value plus about 2% headroom for wording touch-ups,
 *  rounded up to a whole hundred bytes.
 *
 *    agent / restricted        measured 102,525 B over 32 tools  ceiling 104,600
 *    agent / full              measured 110,883 B               ceiling 113,200
 *    mission run / restricted  measured 112,108 B               ceiling 114,400
 *
 *  The two Lighter onboarding shortcuts account for 4,347 B of the restricted
 *  block, 4.2% of what every turn pays, for two tools out of 32. That is the
 *  price of the owner's decision to keep them hot; it is written down here so
 *  the next session reads a measured number instead of re-deriving one, and so
 *  a later edit to those two descriptions has something to move against. The 40
 *  Lighter PROTOCOL schemas are not in this block at all: they stay behind
 *  ToolSearch and are paid only by a session that discovered them.
 */

import { describe, it, expect } from "vitest";

import { toOpenAITools } from "@vex-agent/tools/types.js";
import {
  defaultVisibilityContext,
  getVisibleToolDefs,
  type ToolVisibilityContext,
} from "@vex-agent/tools/registry/visibility.js";

/** The two hot-set rows the owner decided to keep, measured on their own. */
const LIGHTER_SHORTCUTS = ["lighter_rhc_onboarding_status", "lighter_core_onboarding_status"];

function alwaysLoadedBytes(ctx: ToolVisibilityContext, only?: readonly string[]): number {
  const defs = getVisibleToolDefs(ctx).filter(
    (def) => only === undefined || only.includes(def.name),
  );
  return Buffer.byteLength(JSON.stringify(toOpenAITools(defs)), "utf8");
}

const MODES = [
  {
    name: "agent / restricted",
    ctx: defaultVisibilityContext(),
    ceiling: 104_600,
  },
  {
    name: "agent / full",
    ctx: defaultVisibilityContext({ permission: "full" }),
    ceiling: 113_200,
  },
  {
    name: "mission run / restricted",
    ctx: defaultVisibilityContext({ sessionKind: "mission", missionRunActive: true }),
    ceiling: 114_400,
  },
] as const;

describe("always-loaded tool block byte ceilings", () => {
  for (const mode of MODES) {
    it(`${mode.name} stays at or below its measured ceiling`, () => {
      expect(alwaysLoadedBytes(mode.ctx)).toBeLessThanOrEqual(mode.ceiling);
    });
  }

  it("keeps the two Lighter onboarding shortcuts inside their own share", () => {
    const ctx = defaultVisibilityContext();
    const shortcutBytes = alwaysLoadedBytes(ctx, LIGHTER_SHORTCUTS);
    // Both are present: a filter that matched nothing would pass this bound
    // trivially and would stop measuring the thing it exists to measure.
    expect(getVisibleToolDefs(ctx).filter((def) => LIGHTER_SHORTCUTS.includes(def.name))).toHaveLength(2);
    expect(shortcutBytes).toBeLessThanOrEqual(4_500);
  });

  it("does not let the hot set grow silently", () => {
    // The COUNT, not only the bytes: a new always-loaded tool is a budget
    // decision even when it is small, because every one of them is paid on
    // every turn of every session.
    expect(getVisibleToolDefs(defaultVisibilityContext())).toHaveLength(32);
  });
});
