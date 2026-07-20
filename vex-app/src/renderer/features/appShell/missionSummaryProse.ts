/**
 * Mission summary prose — pure reader for the agent-authored `stopSummary`.
 *
 * The mission-run prompt asks the agent to write the `mission_stop` summary
 * as `- `-prefixed bullets in plain language (see
 * `engine/prompts/mission-run.ts`). A model is not a parser, though: it will
 * sometimes emit `*`/`•`/`–` markers, stray indentation, blank lines, or a
 * single paragraph. All of that tolerance lives HERE so the components that
 * render a summary stay dumb.
 *
 * A paragraph is returned as one beat rather than discarded — a summary the
 * user can read badly formatted still beats no summary at all.
 */

/** Bullet glyphs a model reaches for when asked for `- ` bullets. */
const BULLET_MARKER = /^[-*•–—]\s*/;

/**
 * Split agent-authored summary prose into display beats.
 *
 * Returns `[]` for null/blank prose so callers can hide the block entirely,
 * and `[prose]` when the model wrote a paragraph instead of bullets.
 */
export function parseSummaryBullets(summary: string | null | undefined): string[] {
  if (summary === null || summary === undefined) return [];
  const trimmed = summary.trim();
  if (trimmed.length === 0) return [];

  const lines = trimmed.split("\n");
  const bullets: string[] = [];
  let sawMarker = false;

  for (const line of lines) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    if (!BULLET_MARKER.test(candidate)) continue;
    sawMarker = true;
    const text = candidate.replace(BULLET_MARKER, "").trim();
    // A bare marker with no text carries no information — drop it.
    if (text.length > 0) bullets.push(text);
  }

  // No bullet markers at all: the model wrote prose. Surface it as one beat.
  if (!sawMarker) return [trimmed];
  return bullets;
}
