/**
 * THE CODE AREA - a virtualized, horizontally scrolling list of lines.
 *
 * ## The file text is UNTRUSTED and never becomes HTML
 *
 * Every token is a React text node inside a `<span>`. There is no
 * `dangerouslySetInnerHTML` here and there must never be one: the bytes come
 * from a file in the user's project, an agent may have written them, and shiki's
 * own `codeToHtml` is the API this module deliberately does not call. The build
 * gate (`scripts/check-build-artifacts.mjs`, gate 4) fails the build on that
 * attribute anywhere in renderer source, so this is enforced rather than
 * remembered.
 *
 * ## Only the WINDOW is in the DOM, and only colour is a variable
 *
 * The session holds every line of the file; `@tanstack/react-virtual` mounts
 * the ~40 that fit plus the overscan. A 100k-line file therefore costs 100k
 * small arrays in memory and forty rows on screen.
 *
 * A token's colour arrives as the string the css-variables theme produced -
 * `var(--vex-alias-code-token-keyword)` - so it is a SEMANTIC token, not a
 * palette value, and the theme flip repoints it with no re-tokenization. Italic,
 * bold and underline are classes rather than inline styles because they are
 * fixed decisions, not per-token data.
 *
 * ## Horizontal scrolling lives INSIDE this panel
 *
 * Rule 08: wide content scrolls in its own container and the page never scrolls
 * sideways. The scroller owns both axes; each row is `width: max-content` so the
 * scrollable width is the longest line, and the line-number gutter is
 * `position: sticky; left: 0` so the numbers stay put while the code moves under
 * them.
 *
 * The gutter is `aria-hidden` and unselectable: a line number is wayfinding for
 * the eye, and a screen reader announcing "forty-two" before every line, or a
 * Select All that pasted the numbers into the user's clipboard, would both be
 * the decoration pretending to be content.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type CSSProperties, type JSX } from "react";
import { cn } from "../../../../lib/utils.js";
import type { TokenLine } from "./highlight/highlight-protocol.js";
import { CODE_REGION_LABEL } from "./viewer-copy.js";

/** One line's box, in pixels. Must match the `leading-5` on the rows. */
export const VIEWER_LINE_HEIGHT = 20;

/** Lines mounted beyond the viewport, so a fast scroll shows no blank band. */
export const VIEWER_OVERSCAN = 12;

/**
 * The virtualizer's measurement seam.
 *
 * jsdom has no layout - every element measures 0x0 - so the library's own
 * observers compute a zero-height viewport and the list renders nothing at all.
 * The same seam `ExplorerTree` opens, for the same stated reason. Production
 * passes nothing and gets the real observers.
 */
export interface ViewerViewportObservers {
  readonly observeElementRect: Parameters<
    typeof useVirtualizer<HTMLDivElement, HTMLDivElement>
  >[0]["observeElementRect"];
  readonly observeElementOffset: Parameters<
    typeof useVirtualizer<HTMLDivElement, HTMLDivElement>
  >[0]["observeElementOffset"];
}

export interface FileViewerLinesProps {
  /** EVERY line of the file, in order. Tokenized, or one plain token each. */
  readonly lines: readonly TokenLine[];
  readonly viewport?: ViewerViewportObservers;
  readonly className?: string;
}

export function FileViewerLines({
  lines,
  viewport,
  className,
}: FileViewerLinesProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VIEWER_LINE_HEIGHT,
    overscan: VIEWER_OVERSCAN,
    // O(1): virtual-core calls this in an O(count) loop on every measurement
    // rebuild, so anything that walks the file here is O(n^2) per commit.
    getItemKey: (index) => index,
    ...(viewport ?? {}),
  });

  // The gutter is as wide as the widest number it will ever show, so the code
  // column does not shift when the viewport scrolls past line 999.
  const gutterCh = Math.max(3, String(lines.length).length) + 2;

  return (
    <div
      ref={scrollRef}
      data-testid="file-viewer-lines"
      role="region"
      aria-label={CODE_REGION_LABEL}
      tabIndex={0}
      className={cn(
        "vex-scroll min-h-0 flex-1 overflow-auto bg-surface-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      <div
        className="relative w-max min-w-full"
        style={{ height: `${String(virtualizer.getTotalSize())}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <Line
            key={item.key}
            number={item.index + 1}
            tokens={lines[item.index] ?? []}
            gutterCh={gutterCh}
            offset={item.start}
          />
        ))}
      </div>
    </div>
  );
}

function Line({
  number,
  tokens,
  gutterCh,
  offset,
}: {
  readonly number: number;
  readonly tokens: TokenLine;
  readonly gutterCh: number;
  readonly offset: number;
}): JSX.Element {
  return (
    <div
      data-line={number}
      className="absolute top-0 left-0 flex w-max min-w-full font-mono text-[12px] leading-5"
      style={{ height: `${String(VIEWER_LINE_HEIGHT)}px`, transform: `translateY(${String(offset)}px)` }}
    >
      <span
        aria-hidden="true"
        className="sticky left-0 z-10 shrink-0 bg-surface-base pr-3 text-right text-ink-tertiary select-none"
        style={{ width: `${String(gutterCh)}ch` }}
      >
        {number}
      </span>
      <span className="whitespace-pre pr-4 text-ink-primary">
        {tokens.map((token, index) => (
          <span
            // Tokens have no identity of their own and the whole line is
            // replaced together, so the index IS the identity here.
            key={index}
            className={cn(
              token.italic && "italic",
              token.bold && "font-bold",
              token.underline && "underline",
            )}
            style={colourOf(token.color)}
          >
            {token.text}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * A token with no colour of its own INHERITS the code area's foreground.
 *
 * Returning `undefined` rather than a colour is what makes that inheritance
 * real; writing `color: "inherit"` would work too but would put a style
 * attribute on every token of every plain-text file for no effect.
 */
function colourOf(color: string | null): CSSProperties | undefined {
  return color === null ? undefined : { color };
}
