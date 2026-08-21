/**
 * Shared macOS-grade motion constants (owner correction round, 2026-07-20).
 * ONE source for the shell's spring/easing DNA so the screen morph, the
 * profile-menu pop, dialogs and micro-interactions all move with the same
 * hand instead of per-file magic numbers:
 *
 *  - SPRING_PANEL — the big-surface spring: the ShellScreen FLIP morph.
 *  - SPRING_SNAPPY — the small-surface pop: the profile side-panel menu.
 *  - EASE_STANDARD - the design-language §7 transition curve. Anything moving
 *    BETWEEN two resting states: staggers, exits, crossfades.
 *  - EASE_OUT - the landing "Out" curve. ENTRANCES only: a surface arriving
 *    from nothing and decelerating into place (every transcript keyframe).
 *  - EASE_INOUT - full-surface reveals (the Chronos Gate curtain).
 *
 * INVARIANT, three files. This module is the JS mirror of ONE easing family
 * whose CSS side is split across two global sheets: `--vex-ease-standard` in
 * `styles/global-css/motion-primitives.css` (the transcript motion owner) and
 * `--vex-ease-out` / `--vex-ease-inout` in `styles/global-css/shell.css`. A
 * curve changed on one side and not the other splits the family and the app
 * starts moving with two different hands - change every site together.
 *
 * Motion applies these via CSSOM property writes (MOTION-POLICY-safe; no
 * `layout`/`layoutId`, which would inject a runtime stylesheet the CSP
 * blocks). Only transform/opacity animate — plus the ShellScreen morph's
 * border-radius, which the cult ExpandableScreen grammar requires.
 */

export const SPRING_PANEL = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 0.9,
} as const;

export const SPRING_SNAPPY = {
  type: "spring",
  stiffness: 420,
  damping: 34,
} as const;

/** CSS mirror: `--vex-ease-standard` (motion-primitives.css). */
export const EASE_STANDARD = [0.4, 0, 0.2, 1] as const;

/** CSS mirror: `--vex-ease-out` (shell.css). Entrances only. */
export const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/**
 * The landing GSAP "InOut" curve. CSS mirror: `--vex-ease-inout` (shell.css);
 * also hand-duplicated in workspaceTransition.ts. Full-surface reveals only.
 */
export const EASE_INOUT = [0.76, 0, 0.24, 1] as const;
