/**
 * THE ONE ANNOUNCER OF VEX'S STATE (docs/design/R3-MINIMAL.md section 5.2). Mounted once, beside
 * the title bar's token chip, which stands on every screen with a Vex column; the chip and the
 * Vex sidebar draw the word as plain markup and carry no live role, so the word is heard here and
 * only here.
 *
 * What it says and when it stays quiet is `vex-announce.ts`: the word once per change, never for
 * a turn the transcript's turn island is already speaking, never for the user's own typing or
 * move. Two more rules need time, so they live here. A state change and a notification spoken by
 * the app's `NotificationAnnouncer` in the same moment are one event, and the notification is the
 * fuller sentence: the word waits one task (so a notification raised in a sibling's effect of the
 * same commit is seen) and is dropped when any notification was spoken within `SAME_MOMENT_MS` of
 * the change. And a move (the chip mounting, another chat, project or mode) starts reads that
 * settle over a few renders: changes within `SAME_MOMENT_MS` of the move are quiet.
 *
 * The region: a polite `role="status"` pair, alternating (the live-region primitive's rule, so
 * the same word spoken twice in a row is still a DOM change), visually hidden but in the
 * accessibility tree. No severity prefix: a state word is not an error, a warning or info.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { notifications } from "../../lib/notifications/index.js";
import { useUiStore } from "../../stores/uiStore.js";
import { SAME_MOMENT_MS, vexAnnouncementFor, type VexStateRead } from "./vex-announce.js";
import type { VexState } from "./vex-state.js";

export interface VexStateAnnouncerProps {
  readonly state: VexState;
  readonly word: string;
  /** A turn is in flight in the open chat (`VexPresence.live`). */
  readonly live: boolean;
}

interface Pair {
  readonly first: string;
  readonly second: string;
}

const EMPTY: Pair = { first: "", second: "" };

/** Put `text` in whichever half is not already holding it. */
function nextPair(pair: Pair, text: string): Pair {
  return pair.first === text ? { first: "", second: text } : { first: text, second: "" };
}

/** The mode and the open session or project: a change of it is the user's own move. */
function useScopeKey(): string {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  return runtimeMode === "studio"
    ? `studio:${activeProjectId ?? ""}`
    : `${runtimeMode}:${activeSessionId ?? ""}`;
}

export function VexStateAnnouncer({ state, word, live }: VexStateAnnouncerProps): JSX.Element {
  const scopeKey = useScopeKey();
  const [pair, setPair] = useState<Pair>(EMPTY);
  const prev = useRef<VexStateRead | null>(null);
  const lastNoticeAt = useRef(Number.NEGATIVE_INFINITY);
  const movedAt = useRef(Number.NEGATIVE_INFINITY);

  // Every notification the app's announcer speaks, by time: the same predicate it uses.
  useEffect(
    () =>
      notifications.onDidChange((change) => {
        if (change.kind === "remove" || !change.announceable) return;
        lastNoticeAt.current = Date.now();
      }),
    [],
  );

  useEffect(() => {
    const next: VexStateRead = { state, word, live, scopeKey };
    const changedAt = Date.now();
    // Mounting is a move too: the first reads arrive over the next renders.
    if (prev.current === null || prev.current.scopeKey !== scopeKey) movedAt.current = changedAt;
    const text = vexAnnouncementFor(prev.current, next);
    prev.current = next;
    if (text === null || changedAt - movedAt.current < SAME_MOMENT_MS) return undefined;
    // One task later, so a notification raised by a sibling's effect in this commit has landed.
    // A newer change cancels this one: a flicker is one word, the state that holds.
    const timer = window.setTimeout(() => {
      if (lastNoticeAt.current >= changedAt - SAME_MOMENT_MS) return;
      setPair((current) => nextPair(current, text));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [state, word, live, scopeKey]);

  return (
    <div className="sr-only" data-vex-area="vex-state-announcer">
      <span role="status" aria-atomic="true">
        {pair.first}
      </span>
      <span role="status" aria-atomic="true">
        {pair.second}
      </span>
    </div>
  );
}
