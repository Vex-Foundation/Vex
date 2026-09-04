/**
 * SplitPane - a resizable strip of panes along one axis.
 *
 * A shared primitive, not a Studio component: it owns the GEOMETRY of a split
 * (relative shares, minimums, which neighbour a drag trades with) and knows
 * nothing about terminals, files or workspaces. The Studio's workspace model
 * owns the STATE those shares live in and hands them back down as props.
 *
 * ## The two halves, and why they are separate
 *
 * `resizeSplitPaneSizes` is the arithmetic, exported and pure. Both input paths
 * - a pointer drag and an arrow key on the separator - go through it, so the
 * two cannot disagree about what a resize means, and the arithmetic is testable
 * without a layout engine (which jsdom does not have).
 *
 * ## Semantics, taken from VS Code's SplitView
 *
 *  - Shares are RELATIVE and sum to 1, so a restore fits any window size.
 *  - A separator sits BETWEEN two panes and moving it is a transfer between
 *    exactly those two. Growing one pane by taking a slice from every other pane
 *    would move content the user is not dragging.
 *  - THE END PANE INVERTS. The pane at the end of the axis has no neighbour to
 *    its right, so it trades with the pane to its LEFT. Without the inversion, a
 *    resize of the last pane has no partner and either does nothing or silently
 *    renormalizes the whole axis. `workspace-model.ts:resizePane` applies the
 *    same inversion at the state layer, deliberately: the two must agree or a
 *    drag and a restore would disagree about the same gesture.
 *  - A transfer is CLAMPED by what the partner actually has (and by the
 *    minimum), so dragging past a pane's edge stops at the edge rather than
 *    producing a negative share.
 *
 * ## Accessibility
 *
 * Each separator is a real focusable `role="separator"` with `aria-orientation`,
 * `aria-valuenow/min/max` and arrow-key handling, because a split that can only
 * be resized by dragging is a split a keyboard user cannot resize at all. Home
 * and End jump to the minimum and maximum the pooled share allows.
 */

import {
  Fragment,
  isValidElement,
  useCallback,
  useRef,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils.js";

/** How much one arrow keypress moves a separator, as a share of the axis. */
export const SPLIT_PANE_KEYBOARD_STEP = 0.02;

/**
 * Set one pane's share, compensating its neighbour so the axis still sums to 1.
 *
 * The partner is the pane to the RIGHT, except for the END pane, which trades
 * with the pane to its LEFT. `minRelative` is the floor BOTH panes are held to,
 * so a drag can never collapse either side to nothing.
 *
 * Returns a new array; `sizes` is never mutated. A single-pane axis, an unknown
 * index, or a non-finite request returns the input unchanged rather than
 * inventing a layout.
 */
export function resizeSplitPaneSizes(
  sizes: readonly number[],
  index: number,
  nextSize: number,
  minRelative = 0,
): number[] {
  const current = [...sizes];
  if (current.length < 2) return current;
  if (index < 0 || index >= current.length) return current;
  if (!Number.isFinite(nextSize)) return current;

  const partnerIndex = index === current.length - 1 ? index - 1 : index + 1;
  const pooled = (current[index] ?? 0) + (current[partnerIndex] ?? 0);
  // With two minimums to honour there may be no room at all; then the split is
  // left exactly as it was rather than forced past a minimum.
  const floor = Math.min(minRelative, pooled / 2);
  const clamped = Math.min(Math.max(nextSize, floor), pooled - floor);

  current[index] = clamped;
  current[partnerIndex] = pooled - clamped;
  return current;
}

export interface SplitPaneProps {
  /**
   * The axis the panes are laid out ALONG. `"horizontal"` puts them side by
   * side, which makes each separator a vertical bar (`aria-orientation`
   * describes the separator, so it is the opposite word - the ARIA convention,
   * not a typo).
   */
  readonly orientation: "horizontal" | "vertical";
  /** Relative shares, one per child, summing to 1. */
  readonly sizes: readonly number[];
  /** Called with the whole next array whenever a separator moves. */
  readonly onResize: (next: readonly number[]) => void;
  /** Floor for every pane, in px. Ignored while the axis has no measurable size. */
  readonly minPaneSize?: number;
  /** Accessible name for the separator after pane `index`. */
  readonly separatorLabel?: (index: number) => string;
  readonly children: readonly ReactNode[];
  readonly className?: string;
}

const DEFAULT_MIN_PANE_SIZE = 80;

export function SplitPane({
  orientation,
  sizes,
  onResize,
  minPaneSize = DEFAULT_MIN_PANE_SIZE,
  separatorLabel,
  children,
  className,
}: SplitPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    readonly index: number;
    readonly origin: number;
    readonly sizes: readonly number[];
    readonly axisLength: number;
  } | null>(null);

  const horizontal = orientation === "horizontal";

  /** The axis length in px, or 0 when the element has no layout (jsdom, hidden). */
  const axisLength = useCallback((): number => {
    const element = containerRef.current;
    if (element === null) return 0;
    const rect = element.getBoundingClientRect();
    return horizontal ? rect.width : rect.height;
  }, [horizontal]);

  const minRelative = useCallback(
    (length: number): number => (length > 0 ? minPaneSize / length : 0),
    [minPaneSize],
  );

  const handlePointerDown = useCallback(
    (index: number) =>
      (event: PointerEvent<HTMLDivElement>): void => {
        // Only the primary button starts a drag; a context-menu press must not.
        if (event.button !== 0) return;
        event.preventDefault();
        const length = axisLength();
        dragRef.current = {
          index,
          origin: horizontal ? event.clientX : event.clientY,
          sizes: [...sizes],
          axisLength: length,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        // THE SEAM STAYS LIT FOR THE WHOLE DRAG. Pointer capture means the
        // cursor leaves the 8px strip almost immediately, so `:hover` goes
        // false while the user is still dragging and the feedback vanishes at
        // exactly the moment it is being acted on. A DOM attribute rather than
        // React state, for the reason the shell's own handle uses one: a drag
        // emits a move per frame, and re-rendering the whole split to paint a
        // 1px line would make the resize the most expensive thing on screen.
        event.currentTarget.setAttribute("data-dragging", "");
      },
    [axisLength, horizontal, sizes],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      // A drag that started before the element had layout has no scale to
      // convert pixels with, so it moves nothing rather than guessing one.
      if (drag.axisLength <= 0) return;
      const position = horizontal ? event.clientX : event.clientY;
      const deltaRelative = (position - drag.origin) / drag.axisLength;
      const start = drag.sizes[drag.index] ?? 0;
      onResize(
        resizeSplitPaneSizes(
          drag.sizes,
          drag.index,
          start + deltaRelative,
          minRelative(drag.axisLength),
        ),
      );
    },
    [horizontal, minRelative, onResize],
  );

  const endDrag = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    event.currentTarget.removeAttribute("data-dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleKeyDown = useCallback(
    (index: number) =>
      (event: KeyboardEvent<HTMLDivElement>): void => {
        const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
        const increase = horizontal ? "ArrowRight" : "ArrowDown";
        const current = sizes[index] ?? 0;
        const pooled = current + (sizes[index + 1] ?? 0);
        const length = axisLength();
        const floor = Math.min(minRelative(length), pooled / 2);

        let next: number | null = null;
        if (event.key === decrease) next = current - SPLIT_PANE_KEYBOARD_STEP;
        else if (event.key === increase) next = current + SPLIT_PANE_KEYBOARD_STEP;
        else if (event.key === "Home") next = floor;
        else if (event.key === "End") next = pooled - floor;
        if (next === null) return;

        event.preventDefault();
        onResize(resizeSplitPaneSizes(sizes, index, next, minRelative(length)));
      },
    [axisLength, horizontal, minRelative, onResize, sizes],
  );

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0", horizontal ? "flex-row" : "flex-col", className)}
    >
      {children.map((child, index) => {
        const share = sizes[index] ?? 0;
        const isLast = index === children.length - 1;
        const pooled = share + (sizes[index + 1] ?? 0);
        return (
          // The child's OWN key wins when it has one. An index key would make a
          // pane close reshuffle every later pane's identity, remounting hosts
          // that only moved - cheap for a div, a full re-attach for a terminal.
          <Fragment key={keyOf(child, index)}>
            <div
              className="min-h-0 min-w-0 overflow-hidden"
              style={{ flex: `0 0 ${String(share * 100)}%` }}
            >
              {child}
            </div>
            {isLast ? null : (
              <div
                role="separator"
                tabIndex={0}
                aria-orientation={horizontal ? "vertical" : "horizontal"}
                aria-label={separatorLabel?.(index) ?? `Resize pane ${String(index + 1)}`}
                // Percentages of the POOLED share the separator can actually
                // move within, so the reported value means what it says: 50 is
                // the midpoint between these two panes, not of the whole strip.
                aria-valuenow={Math.round(pooled > 0 ? (share / pooled) * 100 : 50)}
                aria-valuemin={0}
                aria-valuemax={100}
                onPointerDown={handlePointerDown(index)}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={handleKeyDown(index)}
                className={cn(
                  "relative shrink-0 bg-line-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // THE SEAM HIGHLIGHT, on the same curve as the shell's own
                  // handle (`.vex-shell-handle::before` in shell.css): the
                  // shared motion tokens rather than Tailwind's defaults, so
                  // every resizable edge in the app settles identically.
                  // `motion-safe:` is the reduced-motion honouring - the colour
                  // still changes, it just stops animating.
                  "motion-safe:transition-colors motion-safe:duration-[var(--vex-duration-fast)]",
                  "motion-safe:ease-[var(--vex-ease-out)]",
                  "hover:bg-accent-primary data-[dragging]:bg-accent-primary",
                  // A 1px stroke with a comfortable grab zone around it: the
                  // visible line is the border, the padding is the target.
                  horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute",
                    horizontal ? "-inset-x-1 inset-y-0" : "-inset-y-1 inset-x-0",
                  )}
                />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** A child's own React key when it has one, its position otherwise. */
function keyOf(child: ReactNode, index: number): string {
  if (isValidElement(child) && child.key !== null) return child.key;
  return `pane-${String(index)}`;
}
