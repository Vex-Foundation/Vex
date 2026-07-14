/**
 * The "liquid pour" transition props (design spec §5), built pure so the
 * reduced-motion branch is testable without rendering framer-motion.
 *
 * Full motion: a mint droplet clip-path reveal expanding from the dock/EXIT
 * corner (the spec's fallback origin when no invoking-card anchor is available),
 * contracting back on exit. `prefers-reduced-motion`: a single 120ms opacity
 * crossfade, no mask, no travel (mirrors the global keyframe-collapse rule).
 * Only clip-path / opacity animate — no layout props, no blur (guard-safe).
 */

import type { Target, Transition } from "motion/react";

/** Droplet origin — the dock edge / EXIT corner (top-right). Both enter and
 * exit pivot here so the meniscus reads as pouring from, and draining to, the
 * copilot the agent spoke through. */
const DROPLET_ENTER = "circle(150% at 88% 8%)";
const DROPLET_COLLAPSED = "circle(0% at 88% 8%)";

/** Brand InOut curve (globals.css `--vex-ease-inout`), as a framer array. */
const EASE_INOUT: readonly [number, number, number, number] = [0.76, 0, 0.24, 1];

export interface WorkspaceTransitionProps {
  readonly initial: Target;
  readonly animate: Target;
  readonly exit: Target;
  readonly transition: Transition;
}

export function buildWorkspaceTransition(
  reduceMotion: boolean,
): WorkspaceTransitionProps {
  if (reduceMotion) {
    // No mask, no travel: a plain 120ms opacity crossfade both ways.
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: 0.12 },
    };
  }
  return {
    initial: { clipPath: DROPLET_COLLAPSED, opacity: 1 },
    animate: { clipPath: DROPLET_ENTER, opacity: 1 },
    exit: { clipPath: DROPLET_COLLAPSED, opacity: 1 },
    transition: { duration: 0.62, ease: [...EASE_INOUT] },
  };
}
