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
 * REGISTER: `.vex-reasoning-prose` and `.vex-reasoned__body` - the opened
 * Reasoned row of docs/design/R3-MINIMAL.md section 6: italic 14 ink 2 on a
 * 1px rule with 12 clear. Thinking aloud is not speaking. The same classes
 * dress the settled thoughts and the persisted `ReasonedBlock`, so a trace
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
import { StreamingMarkdownContent } from "../../../lib/markdown/StreamingMarkdownContent.js";
import { useFrameThrottledValue } from "../../../lib/use-throttled-visual-update.js";

export const LiveReasoning = memo(function LiveReasoning({
  text,
}: {
  readonly text: string;
}): JSX.Element {
  // A5/A6: the live trace streams at token rate; render the frame-throttled
  // snapshot through the incremental renderer (settled blocks lex once).
  const throttledText = useFrameThrottledValue(text);
  return (
    <div
      data-vex-island-reasoning=""
      className="vex-reasoning-prose vex-reasoned__body vex-live-trace break-words"
    >
      <StreamingMarkdownContent text={throttledText} />
    </div>
  );
});
