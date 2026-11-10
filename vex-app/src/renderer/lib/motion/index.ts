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
 * Four durations sit outside the scale, named in the policy's exception
 * list: Kimm's section opens in `DURATION_VEX_OPEN_MS` and closes in
 * `DURATION_VEX_CLOSE_MS` (docs/design/H3-DESKTOP.md section 3.1), a running
 * square blinks once every `DURATION_BLINK_MS` (section 2.2), and a key's
 * hover fill rises in `DURATION_KEY_FILL_MS` (section 5.2).
 *
 * ## The easing family
 *
 * ONE family, five curves, no sixth. CSS mirrors `--vex-ease-standard`,
 * `--vex-ease-out`, `--vex-ease-inout` and `--vex-ease-push`, all declared in
 * `tokens.css` (they used to be split across `shell.css` and
 * `motion-primitives.css`, which is how `dialog[open]` came to hardcode a
 * stray curve while its comment claimed it was on the family one). The
 * fourth, the push curve, belongs to Kimm's section and the chats panel. The
 * fifth, the house curve (`EASE_HOUSE`), is JS only: a page's fade as it
 * re-lays (`features/appShell/page-relay.ts`), and nothing else.
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
 * A full-surface reveal: the shell's column tracks (the Vex sidebar opening
 * and hiding). Reserved for layout-owning surfaces; nothing inside a panel may
 * use it. CSS: `--vex-duration-reveal`.
 */
export const DURATION_REVEAL_MS = 300;

/**
 * Kimm's section opening: the clip-path wipe from the 56px strip down to her
 * foot, with her 32px drop, on `EASE_PUSH`. A named exception to the scale
 * (MOTION-POLICY.md), printed on the mockup's open strip. The next-step
 * bar's rise reads its CSS twin too (H3-DESKTOP.md section 5.10).
 * CSS: `--vex-duration-vex-open`.
 */
export const DURATION_VEX_OPEN_MS = 720;

/**
 * Kimm's section closing: the wipe back up to the strip, on `EASE_PUSH`
 * ("arrive slowly, leave fast": the same curve on the shorter duration).
 * CSS: `--vex-duration-vex-close`.
 */
export const DURATION_VEX_CLOSE_MS = 420;

/**
 * The shortest a turned-around leg of her wipe may take: a press during a
 * motion turns it from the edge where it stands over
 * max(140, base x distance left / distance), base being the new direction's
 * 720 or 420 (VEX Cloud's `TURN_MIN_MS`, its motion contract section 4), so a
 * turn near the end never snaps. JS only, a Web Animations duration with no
 * CSS twin (`components/vex/kimm/kimm-wipe.ts`).
 */
export const DURATION_VEX_TURN_MIN_MS = 140;

/**
 * How long after a Hide Vex press the console's rest takes no pointer at the
 * least (VEX Cloud's `SECTION_GUARD_MS`): the guard lifts once the close has
 * ended, this long has passed since the press, and the pointer has left the
 * pressed key's box (`components/vex/kimm/kimm-guard.ts`). A timer, not a
 * motion: nothing moves for it.
 */
export const DURATION_VEX_GUARD_MS = 500;

/**
 * THE CHATS PANEL (docs/design/H3-DESKTOP.md section 4.12; `ChatsPanel.tsx`):
 * under 1280 the rail's key slides the 248 chats panel out of the rail over
 * Vex's column. VEX Cloud's own motion (`h3-shell-gaps/js/shell.js`
 * `setLeftOver`), a named exception in MOTION-POLICY.md:
 *
 *   - the panel: translate3d(-100%) to none, `DURATION_VEX_OPEN_MS` to open
 *     and `DURATION_VEX_CLOSE_MS` to close (Cloud's push and fold), on
 *     `EASE_PUSH`, the close playing the same keyframes in reverse;
 *   - the scrim beside it: opacity, `DURATION_CHATS_SCRIM_OPEN_MS` in and
 *     `DURATION_CHATS_SCRIM_CLOSE_MS` out, on `EASE_PUSH`;
 *   - its first rows as it opens: from 16px left and transparent, each over
 *     `DURATION_CHATS_ROW_MS` on `EASE_PUSH`, row n after
 *     `CHATS_ROW_DELAY_MS + n * CHATS_ROW_STAGGER_MS`, the first
 *     `CHATS_ROW_ENTER_MAX` of them.
 *
 * Web Animations only, no CSS twin: nothing in a sheet reads these. Reduced
 * motion and Save-Data land the panel at once.
 */
export const DURATION_CHATS_SCRIM_OPEN_MS = 600;
export const DURATION_CHATS_SCRIM_CLOSE_MS = 300;
export const DURATION_CHATS_ROW_MS = 620;
export const CHATS_ROW_DELAY_MS = 120;
export const CHATS_ROW_STAGGER_MS = 45;
export const CHATS_ROW_ENTER_MAX = 12;

/**
 * One cycle of the running square's blink (PD-06): opacity 1 to 0.25 on
 * steps(2, end), VEX Cloud's built `--vx-blink`. A named exception to the
 * scale (MOTION-POLICY.md). Nothing in JS times against it; the mirror keeps
 * the number in one place.
 * CSS: `--vex-duration-blink`.
 */
export const DURATION_BLINK_MS = 600;

/**
 * One cycle of the loading hatch's blink: the same two steps as the running
 * square at half the pace, VEX Cloud's built `--vx-blink-hatch`. A named
 * exception to the scale (MOTION-POLICY.md). Nothing in JS times against it.
 * CSS: `--vex-duration-blink-hatch`.
 */
export const DURATION_BLINK_HATCH_MS = 1200;

/**
 * The loader gate's exit (`components/brand/LoaderGate.tsx`, VEX Cloud's
 * `--vx-dur-item`, `--vx-dur-gate` and `--vx-dur-item-fade`): the gate fades
 * over 600ms while its mark lifts out to 96% over 700ms and fades over 500ms.
 * Named exceptions to the scale (MOTION-POLICY.md). The fade is paired with
 * the component's backstop timer, which reads `DURATION_GATE_FADE_MS`.
 * CSS: `--vex-duration-gate-fade`, `--vex-duration-gate-mark`,
 * `--vex-duration-gate-mark-fade`.
 */
export const DURATION_GATE_FADE_MS = 600;
export const DURATION_GATE_MARK_MS = 700;
export const DURATION_GATE_MARK_FADE_MS = 500;

/**
 * The general key's hover fill: it rises from the key's foot (VEX Cloud's
 * `--vx-dur-fill`, docs/design/H3-DESKTOP.md section 5.2). A named exception
 * to the scale (MOTION-POLICY.md), owned by `components/ui/button.tsx`.
 * CSS: `--vex-duration-key-fill`.
 */
export const DURATION_KEY_FILL_MS = 420;

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

/**
 * The push curve, Kimm's section, the chats panel, the toast's arrival and
 * the next-step bar's rise only (docs/design/H3-DESKTOP.md sections 3.1,
 * 4.12, 5.1 and 5.10): derived from the clip insets the mockup prints on its open and close
 * strips, which it reproduces to the printed digits. CSS mirror:
 * `--vex-ease-push`.
 */
export const EASE_PUSH = [0.22, 1, 0.36, 1] as const;

/**
 * The house curve, VEX Cloud's `--vx-ease-ease` (motion contract section 2):
 * a page's fade from 0.4 as it re-lays at a Show Vex or Hide Vex press
 * (docs/design/H3-DESKTOP.md section 1.9, EC-26; `page-relay.ts`), and
 * nothing else on desktop. JS only, a Web Animations curve with no CSS twin.
 * It is the review sheet's `--ease`, which is NOT her section's wipe (that is
 * `EASE_PUSH`, `motion-tokens.test.ts`).
 */
export const EASE_HOUSE = [0.625, 0.05, 0, 1] as const;

/**
 * A curve of the family as CSS spells it, for a Web Animations call: the one
 * place outside tokens.css a `cubic-bezier()` string is made, and only from
 * the family's own control points.
 */
export function cssCurve(curve: readonly [number, number, number, number]): string {
  return `cubic-bezier(${curve.join(", ")})`;
}
