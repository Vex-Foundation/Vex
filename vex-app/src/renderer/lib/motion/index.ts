/**
 * THE MOTION VOCABULARY, JS side.
 *
 * One module owns every number and curve the app moves with, so the screen
 * morph, the shell columns, dialogs, Studio surfaces and micro-interactions
 * all move with the same hand instead of per-file magic numbers. The binding
 * rules - what motion is for, the reduced-motion contract, the CSP rule and
 * the cross-file timing-invariant rule - live in `vex-app/MOTION-POLICY.md`
 * under "Motion vocabulary"; this file is that document's executable half.
 *
 * ## The duration scale
 *
 * Five steps, each the CSS mirror of a `--vex-duration-*` custom property
 * declared in `styles/global-css/tokens.css`. The pairing is asserted by
 * `styles/global-css/__tests__/motion-tokens.test.ts`, which fails if either
 * side moves alone.
 *
 * ## The easing family
 *
 * ONE family, three curves, no fourth. CSS mirrors `--vex-ease-standard`,
 * `--vex-ease-out` and `--vex-ease-inout`, all three declared in `tokens.css`
 * (they used to be split across `shell.css` and `motion-primitives.css`, which
 * is how `dialog[open]` came to hardcode a fourth curve while its comment
 * claimed it was on the family one).
 *
 * ## Springs
 *
 * Springs have no CSS mirror - they exist only for Motion call sites, which
 * apply them via CSSOM property writes (MOTION-POLICY-safe; no `layout` /
 * `layoutId`, which would inject a runtime stylesheet the CSP blocks).
 */

export {
  prefersReducedMotion,
  subscribeReducedMotion,
  useReducedMotion,
} from "./reduced-motion.js";

/** No motion at all: the reduced-motion resting value. CSS: `--vex-duration-instant`. */
export const DURATION_INSTANT_MS = 0;

/**
 * Micro-feedback on a surface the pointer is already on: hover tints, the
 * resize seam highlight. CSS: `--vex-duration-fast`. VS Code's sash uses the
 * same 100ms for the same job (`sash.css`, `.monaco-enable-motion` rule).
 */
export const DURATION_FAST_MS = 100;

/**
 * The default: a state change on one component - selection, expand/collapse,
 * a panel arriving. CSS: `--vex-duration-base`.
 */
export const DURATION_BASE_MS = 150;

/** A modal or an overlay taking the screen. CSS: `--vex-duration-slow`. */
export const DURATION_SLOW_MS = 240;

/**
 * A full-surface reveal: the shell's column tracks, the BOOK panel. Reserved
 * for layout-owning surfaces; nothing inside a panel may use it.
 * CSS: `--vex-duration-reveal`.
 */
export const DURATION_REVEAL_MS = 300;

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

/**
 * The design-language section 7 transition curve. Anything moving BETWEEN two
 * resting states: staggers, exits, crossfades. CSS mirror:
 * `--vex-ease-standard`.
 */
export const EASE_STANDARD = [0.4, 0, 0.2, 1] as const;

/**
 * The landing "Out" curve. ENTRANCES only: a surface arriving from nothing and
 * decelerating into place. CSS mirror: `--vex-ease-out`.
 */
export const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/**
 * The landing GSAP "InOut" curve. Full-surface reveals only. CSS mirror:
 * `--vex-ease-inout`; also hand-duplicated in workspaceTransition.ts.
 */
export const EASE_INOUT = [0.76, 0, 0.24, 1] as const;
