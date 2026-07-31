/**
 * LIVE REASONING — the ACTIVE thought, streaming inline as markdown.
 *
 * Owner decree 2026-07-30: reasoning "streamuje jako normalna wiadomość […]
 * bez cięć". So there is no window, no `max-height`, no bottom-pin and no
 * fade: the active segment occupies whatever height it needs, exactly like a
 * message, and the transcript scrolls around it. (The 46px masked peek this
 * replaced is long gone; the 240px scroll box that replaced THAT is gone now
 * too — a box that scrolls independently inside a scrolling transcript is two
 * competing scroll contexts, and it cut the thought mid-sentence.)
 *
 * REGISTER: `.vex-reasoning-prose` — Instrument Serif ITALIC, muted. Thinking
 * aloud is not speaking, so it is not set in the speaking face. The same class
 * dresses the settled stamps and the persisted `ReasonedBlock`, so a trace
 * looks the same whether it is streaming, folded, or reopened a week later.
 *
 * Two throttles stack, deliberately, and neither may be removed:
 *
 *  1. `streamStore` already batches reasoning deltas into ONE state write per
 *     80ms window (`REASONING_FLUSH_MS`) — that bounds React renders.
 *  2. This component throttles the MARKDOWN PARSE to one per
 *     `REASONING_PARSE_MS` (~400ms). Re-parsing a 16KB trace at the store's
 *     flush rate is the expensive part, and it is invisible work: a reader
 *     cannot perceive prose re-flowing more than a couple of times a second.
 *
 * The throttle NEVER swallows the tail: when `live` goes false (thinking
 * ended, the turn errored, or the component unmounts the live state) the final
 * text is parsed IMMEDIATELY, so what settles is always the complete trace.
 *
 * Memoized on the parsed text so an 80ms reasoning flush cannot re-parse the
 * ANSWER markdown living in `StreamingBubble` — that memo boundary is the
 * reason the two bodies are separate subtrees.
 */

import { memo, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";

/** One markdown parse per this window while reasoning streams. */
export const REASONING_PARSE_MS = 400;

export const LiveReasoning = memo(function LiveReasoning({
  text,
  live,
}: {
  readonly text: string;
  /** True while reasoning is still streaming; false forces a final parse. */
  readonly live: boolean;
}): JSX.Element {
  const [committed, setCommitted] = useState(text);
  const latestRef = useRef(text);
  const timerRef = useRef<number | null>(null);
  const lastCommitRef = useRef(0);

  latestRef.current = text;

  useEffect(() => {
    const clear = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    // Not live any more: the tail is committed at once, never dropped.
    if (!live) {
      clear();
      setCommitted(latestRef.current);
      return;
    }

    const since = Date.now() - lastCommitRef.current;
    if (since >= REASONING_PARSE_MS) {
      lastCommitRef.current = Date.now();
      setCommitted(latestRef.current);
      return;
    }
    if (timerRef.current !== null) return; // a commit is already scheduled
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastCommitRef.current = Date.now();
      setCommitted(latestRef.current);
    }, REASONING_PARSE_MS - since);
  }, [text, live]);

  // Unmount is the only cleanup edge — an orphan timer would setState on a
  // dead component the moment a turn ends mid-window.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const body = useMemo(
    () => <MarkdownContent text={committed} />,
    [committed],
  );

  return (
    <div
      data-vex-island-reasoning=""
      className="vex-reasoning-prose break-words text-[14px] leading-[1.6]"
    >
      {body}
    </div>
  );
});
