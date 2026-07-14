/**
 * HypervexingSummon — the composer's recognition ritual. While the draft
 * contains the summoning word ("hypervexing"), concentric mint waves ripple
 * outward from the composer pill and the Hyperliquid logomark surfaces above
 * its edge: the app acknowledges the invocation BEFORE the user sends it.
 *
 * Colors are the Hyperliquid brand family (mode tokens' mint/teal) regardless
 * of the current shell theme — protocol ink, like HlLiquidVeil. All motion
 * lives in globals.css (`hv-summon-*`), collapses under reduced-motion to a
 * static mint hairline, and is border/opacity-based — no glow shadows, no
 * blur (design-guard clean).
 *
 * Mount inside the composer pill (relative, overflow-visible); purely
 * decorative (`aria-hidden`, pointer-events-none).
 */

import type { JSX } from "react";

export function HypervexingSummon({
  active,
}: {
  readonly active: boolean;
}): JSX.Element | null {
  if (!active) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      <span className="hv-summon-wash" />
      <span className="hv-summon-ring hv-summon-ring--1" />
      <span className="hv-summon-ring hv-summon-ring--2" />
      <span className="hv-summon-ring hv-summon-ring--3" />
      <img src="/protocols/hl.png" alt="" className="hv-summon-mark" />
    </span>
  );
}
