/**
 * Motion DNA for the welcome-stage floating Portfolio tab — the same
 * spring/stagger hand as the SidebarProfile menu (SPRING_PANEL carries the
 * surface, EASE_STANDARD cascades the rows), shared between the panel (stack
 * variants) and the cards (each card is a motion child riding
 * `cardVariants`). MOTION-POLICY compliant: only transform/opacity animate;
 * no `layout`/`layoutId` (they inject a runtime stylesheet the CSP bans).
 *
 * The stack's hidden/exit frames translate down and scale toward the round
 * handle button (the panel sets `origin-bottom-right`), so expanding reads
 * as the button growing into the card stack and collapsing as the stack
 * settling back down onto it — one object morphing, never two unrelated
 * elements. The exit is a short tween (not the spring) so the collapse
 * lands without wobble.
 */

import type { Variants } from "motion/react";
import { EASE_STANDARD, SPRING_PANEL } from "../../../../lib/motion/index.js";

export const stackVariants: Variants = {
  hidden: { opacity: 0, y: 28, scale: 0.62 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      ...SPRING_PANEL,
      delayChildren: 0.06,
      staggerChildren: 0.05,
    },
  },
  exit: {
    opacity: 0,
    y: 22,
    scale: 0.7,
    transition: { duration: 0.18, ease: EASE_STANDARD },
  },
};

export const cardVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_STANDARD } },
};

/** jsdom-safe reduced-motion probe (same pattern as SidebarProfile). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
