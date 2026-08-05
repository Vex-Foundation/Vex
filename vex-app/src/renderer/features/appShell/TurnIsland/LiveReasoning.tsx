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
 * ONE STREAMING METHOD (owner decree 2026-08-03). This component used to carry
 * its OWN 400ms markdown-parse throttle plus a commit buffer — a second
 * streaming implementation living beside the answer body's. Both halves of a
 * turn now travel the same path: the store coalesces every delta kind on one
 * flush window, and `MarkdownContent` memoizes the parse on the text. The
 * throttle is deleted, not relocated; nothing here needs to buffer a tail,
 * because there is no longer a slower path for the tail to be lost in.
 */

import { memo, type JSX } from "react";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";

export const LiveReasoning = memo(function LiveReasoning({
  text,
}: {
  readonly text: string;
}): JSX.Element {
  return (
    <div
      data-vex-island-reasoning=""
      className="vex-reasoning-prose break-words text-[14px] leading-[1.6]"
    >
      <MarkdownContent text={text} />
    </div>
  );
});
