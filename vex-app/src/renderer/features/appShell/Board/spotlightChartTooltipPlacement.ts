/**
 * WHERE THE CROSSHAIR TOOLTIP SITS, as pure geometry.
 *
 * The anchor is the library's own coordinate pair (`timeToCoordinate` /
 * `priceToCoordinate`), so the card sits on the dot it describes. Nothing in
 * the library keeps that card inside the pane, though: at the newest bar it
 * runs off the right edge and at the top of the range it runs off the top,
 * and a tooltip the reader cannot read is the same defect as no tooltip.
 *
 * THE POLICY, and it is two different policies on the two axes because the
 * failure is different on each:
 *  - HORIZONTALLY the card is centred on the anchor and CLAMPED into the
 *    box. Flipping it left or right of the crosshair would move the price
 *    away from the dot for no gain, since a centred card only ever overflows
 *    by half its width.
 *  - VERTICALLY the card sits above the anchor and FLIPS below it when there
 *    is not enough room above, which is what the mockup's card does at the
 *    top of a spike. A flip that still does not fit is clamped, so the last
 *    word belongs to the container in every case.
 *
 * The result is always fully inside `container` when the card fits in it at
 * all; when it does not (a container smaller than the card, which jsdom and
 * a mid-resize frame can both produce) the card is pinned to the top-left
 * margin rather than being given a negative position.
 */

export interface TooltipAnchor {
  /** Pane coordinates from the library, in CSS pixels. */
  readonly x: number;
  readonly y: number;
}

export interface TooltipBox {
  readonly width: number;
  readonly height: number;
}

export interface TooltipPlacementInput {
  readonly anchor: TooltipAnchor;
  /** The chart container's own box; the tooltip is positioned inside it. */
  readonly container: TooltipBox;
  readonly tooltip: TooltipBox;
  /** Clearance between the anchor and the near edge of the card. */
  readonly gap: number;
  /** Clearance between the card and the container's edges. */
  readonly margin: number;
}

export interface TooltipPlacement {
  /** Top-left corner of the card, in container coordinates. */
  readonly left: number;
  readonly top: number;
  /** The card had to move off centre to stay inside the box. */
  readonly clampedX: boolean;
  /** The card sits BELOW the anchor because it did not fit above. */
  readonly flippedY: boolean;
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

export function placeSpotlightTooltip(
  input: TooltipPlacementInput,
): TooltipPlacement {
  const { anchor, container, tooltip, gap, margin } = input;

  const centred = anchor.x - tooltip.width / 2;
  const left = clamp(centred, margin, container.width - tooltip.width - margin);

  const above = anchor.y - gap - tooltip.height;
  const flippedY = above < margin;
  const raw = flippedY ? anchor.y + gap : above;
  const top = clamp(raw, margin, container.height - tooltip.height - margin);

  return {
    left,
    top,
    clampedX: left !== centred,
    flippedY,
  };
}
