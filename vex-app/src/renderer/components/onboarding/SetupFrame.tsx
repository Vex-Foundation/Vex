/**
 * SetupFrame — the shared pre-shell scaffold (Chronos rebrand, AMENDMENT
 * A2; INK REDESIGN 2026-07-27). Replaces the NOTARY-era NotaryPage.
 *
 * Every pre-shell screen (systemCheck, dockerBootstrap, composeBootstrap,
 * migrations, unlock) paints the exact SetupGate plate — deep ink-navy
 * (`.vex-gate-plate`) + `.vex-gate-vignette` + `.vex-noise` grain — so
 * the whole pre-boot experience reads as ONE continuous room; each screen
 * is a slide on the same plate. Cobalt is the accent on that plate, not
 * the plate itself (it was the surface until the ink redesign).
 *
 * Chrome: top-left brand mark (logo + VEX), bottom-right version. The
 * optional serif title + subline keep the type ramp single-sourced;
 * screens with a bespoke header (unlock) pass children only.
 *
 * Contracts:
 *   - `data-vex-screen={screen}` is the stable e2e/test selector.
 *   - `data-vex-onboarding="true"` keeps the shared onboarding accent
 *     scope (scrollbars, `--vex-onboarding-accent`) alive.
 *   - `data-vex-gate="true"` applies the pre-shell token re-projection
 *     from `global-css/chronos-gate.css`: theme-aware hairlines,
 *     accent-as-text tokens, the Doto micro-label voice, AND the
 *     pre-shell type scale. The frame ALSO stamps it on documentElement for
 *     its own lifetime so body-portaled surfaces keep the projection
 *     (`useGateDocumentScope` below).
 *
 * The plate follows the theme since round 2 (ratified 2026-08-21): celeris
 * gets a light setup stack, chronos keeps the ink room. Only the Chronos
 * Gate itself stays theme-invariant.
 */

import { useEffect, type JSX, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * Live SetupFrame count. The pre-shell stage crossfades screens through
 * `AnimatePresence`, so two frames are mounted at once mid-transition;
 * without a count the outgoing frame's cleanup would retract the scope
 * while the incoming one still needs it.
 */
let mountedFrames = 0;

/**
 * Carry the `[data-vex-gate]` token scope on documentElement for as long as
 * ANY pre-shell screen is mounted.
 *
 * Why the root and not only the frame: toasts, hover cards and menus portal
 * to `document.body`, which sits OUTSIDE the frame, so a portaled surface
 * opened from a pre-shell screen silently reverted to shell values - wrong
 * hairline strength, wrong `--vex-accent-text`, the shell type scale, no
 * Doto voice. Stamping the root is the smallest seam that reaches every
 * portal target without editing ~30 dual-hosted call sites. The six wizard
 * steps that ALSO render inside Settings are unaffected: there they render
 * without SetupFrame, so the scope is never stamped.
 *
 * Cleanup is idempotent and count-guarded; the attribute is removed only
 * once the last frame unmounts.
 */
function useGateDocumentScope(): void {
  useEffect(() => {
    mountedFrames += 1;
    document.documentElement.dataset["vexGate"] = "true";
    return () => {
      mountedFrames -= 1;
      if (mountedFrames <= 0) {
        mountedFrames = 0;
        delete document.documentElement.dataset["vexGate"];
      }
    };
  }, []);
}

interface SetupFrameProps {
  /** Value for data-vex-screen (stable e2e/test selector). */
  readonly screen: string;
  /** Column width: md = 560px (default), lg = 640px (docker/compose). */
  readonly maxWidth?: "md" | "lg";
  /** Optional serif screen title (sentence case, one per surface). */
  readonly title?: string;
  readonly subline?: string;
  readonly children: ReactNode;
}

export function SetupFrame({
  screen,
  maxWidth = "md",
  title,
  subline,
  children,
}: SetupFrameProps): JSX.Element {
  useGateDocumentScope();
  return (
    <main
      data-vex-onboarding="true"
      data-vex-gate="true"
      data-vex-screen={screen}
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden px-6 py-16 text-ink-primary"
    >
      {/* THE PLATE — identical paint stack to the SetupGate curtain, so
       * the curtain reveal opens onto the same color it was made of. */}
      <div aria-hidden className="vex-gate-plate absolute inset-0" />
      <div aria-hidden className="vex-gate-vignette absolute inset-0" />
      <div aria-hidden className="vex-noise pointer-events-none absolute inset-0" />

      {/* Corner chrome — the mark alone top-left (owner decree 2026-07-22:
       * no "VEX" wordmark text beside it), version bottom-right. */}
      <div className="pointer-events-none absolute left-6 top-6 z-10">
        {/* Theme-swapped pair (same idiom as SessionWelcomeHero): white on
         * the chronos ink plate, brand blue on the celeris light plate. An
         * arbitrary parent variant on the theme attribute - no JS read. */}
        <img
          src="/brand/vex-mark-white.svg"
          alt=""
          aria-hidden
          draggable={false}
          className="h-6 w-auto select-none [[data-vex-theme=celeris]_&]:hidden"
        />
        <img
          src="/brand/vex-mark-color.svg"
          alt=""
          aria-hidden
          draggable={false}
          className="hidden h-6 w-auto select-none [[data-vex-theme=celeris]_&]:block"
        />
      </div>
      <span className="pointer-events-none absolute bottom-7 right-10 z-10 vex-micro text-ink-tertiary">
        v{__VEX_APP_VERSION__}
      </span>

      {/* THE PAGE COLUMN — with the container card retired (AMENDMENT A3,
       * boxless composition) this column IS the page: content sits
       * directly on the plate and the COLUMN scrolls when tall (no inner
       * scroll wells anywhere beneath). */}
      <div
        className={cn(
          // max-w = readable measure (640/560) + 4rem for .vex-gate-page's
          // symmetric scrollbar gutter (chronos-gate.css) — keeps the thumb
          // off the text column without narrowing or de-centering it.
          "vex-gate-page relative z-10 flex max-h-full w-full flex-col",
          maxWidth === "lg" ? "max-w-[704px]" : "max-w-[624px]",
        )}
      >
        {/* Centered header (owner review 2026-07-27): the title used to sit
         * flush-left above centered CTAs, which read unbalanced. Only the
         * HEADER centers — the bodies below keep their own alignment, so a
         * centered header over a left-aligned probe list, service table or
         * password form is the intended composition. The wizard's step
         * header matches this rhythm via the `[data-vex-gate]` scope.
         * `text-2xl` is 40px here: the gate re-pins `--text-2xl`. */}
        {title !== undefined ? (
          <header className="vex-rise mb-6 flex flex-col items-center gap-2 text-center">
            <h1 className="font-serif text-2xl font-normal leading-tight text-ink-primary">
              {title}
            </h1>
            {subline !== undefined ? (
              <p className="text-lg leading-relaxed text-ink-secondary">
                {subline}
              </p>
            ) : null}
          </header>
        ) : null}
        {children}
      </div>
    </main>
  );
}
