/**
 * The launch dialog's shared DISPLAY VOCABULARY - the small pure surface the
 * launch lane presents its own state through.
 *
 * WHY IT IS PURE AND SEPARATE: what this file decides is what a spend-consent
 * dialog SAYS. Under owner decision D3 the Deploy click is the consent, so the
 * sentence beside a refusal and the tone of a completed launch are part of that
 * consent surface, not styling. Keeping them out of the components makes them
 * directly testable.
 *
 * WHAT IT NO LONGER HOLDS, and why. This file used to own the launch dialog's
 * wei arithmetic (`parseWei`, `formatWeiEth`, `estimatedTotalCostWei`,
 * `normalizeEthInput`) and the `tokenLaunch.*` refusal table. Both belonged to
 * Trench Express, whose dialog priced a launch in the renderer from a
 * continuously refetched preview. pools.fun does not work that way: main
 * prepares and verifies the calldata and hands back the costs leg by leg
 * already formatted, so there is no renderer-side money arithmetic left to do
 * and no `tokenLaunch.*` code left to classify. Migration 108 retired that
 * protocol; the helpers went with it rather than staying as an unused second
 * way to format an amount (`.claude/CLAUDE.md`, dead code is deleted).
 */

/**
 * The standing sentence beside a `re_review` phase. The specifics (what moved,
 * from what to what) come from main's own message, which is rendered next to
 * this; this line only explains why the button went away.
 */
export const RE_REVIEW_NOTE =
  "The amounts you were shown are no longer current, so nothing was signed. Review the new numbers before deploying.";

/**
 * How a COMPLETED launch is presented.
 *
 * `success` is the confirmed receipt; `caution` is a real spend whose outcome is
 * not yet proven; `failure` is a launch that burned gas and created nothing. The
 * tone exists because every completed submit used to render green, which paints
 * a REVERTED launch as a success.
 */
export type TerminalTone = "success" | "caution" | "failure";

/**
 * Links are user-authored and travel into a token's public metadata. Only
 * `https:` is accepted - `javascript:`, `data:` and bare `http:` are refused at
 * the field rather than sanitized later, so the untrusted value never reaches a
 * renderer sink or the calldata in the first place (rule 03 boundary law).
 */
export function isAcceptableLaunchLink(value: string): boolean {
  if (value.length === 0) return true; // an empty row is simply unfilled
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:";
}
