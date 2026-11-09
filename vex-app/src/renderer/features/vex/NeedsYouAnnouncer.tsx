/**
 * THE NEEDS YOU ANNOUNCER (VEX Cloud's `components/shell/needs-announcer.tsx`,
 * its spec 12.7 rule 3; docs/design/H3-DESKTOP.md section 4.8). Needs you has
 * one carrier, the console (or its line under 1024, or the page strip), and
 * no header control, so nothing else says when a decision arrives from
 * another chat, a mission or a Studio project. This says it, politely:
 * "{count} awaiting your approval", when the count rises after a count that
 * was already known, for one poll's length (`NEEDS_YOU_ANNOUNCE_MS`); the
 * first count and a fall are silent, and a fall clears what was said.
 *
 * The count is the shared Needs you model's (`useNeedsYou`), the one the
 * console, the console line and the Vex key show, so the words can never
 * disagree with what is drawn. A count is known only while the model is
 * ready: a read still loading or one that failed leaves the last known count
 * as it was, so a decision that lands while a read is failing is said once
 * the read recovers.
 *
 * A visually hidden `role="status"` span that stays mounted at 0, so a rise
 * from 0 is heard. Mounted once, beside the app's notification announcer in
 * the header (`RunningHead`), so a rise is never said twice.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { useNeedsYou } from "./useVexPresence.js";

/** How long the words stay in the region: Cloud's one poll (30 s). */
export const NEEDS_YOU_ANNOUNCE_MS = 30_000;

/** Whether a count change is said: only a rise after a known count. */
export function needsYouRiseSaid(previous: number | null, next: number | null): boolean {
  return previous !== null && next !== null && next > previous;
}

/** Cloud's words for a rise. */
export function needsYouRiseWords(count: number): string {
  return `${String(count)} awaiting your approval`;
}

function stopTimer(timer: { current: number | null }): void {
  if (timer.current !== null) window.clearTimeout(timer.current);
  timer.current = null;
}

export function NeedsYouAnnouncer(): JSX.Element {
  const { status, count } = useNeedsYou();
  const [said, setSaid] = useState("");
  const previous = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const known = status === "ready" ? count : null;

  // The words' own clock, apart from the count: a read failing mid-way
  // neither cuts the words short nor leaves them standing.
  useEffect(
    () => () => {
      stopTimer(timer);
    },
    [],
  );

  useEffect(() => {
    if (known === null) return;
    const before = previous.current;
    previous.current = known;
    if (!needsYouRiseSaid(before, known)) {
      if (before !== null && known < before) {
        stopTimer(timer);
        setSaid("");
      }
      return;
    }
    stopTimer(timer);
    setSaid(needsYouRiseWords(known));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setSaid("");
    }, NEEDS_YOU_ANNOUNCE_MS);
  }, [known]);

  return (
    <span role="status" aria-live="polite" className="sr-only" data-vex-area="needs-you-announcer">
      {said}
    </span>
  );
}
