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
 *     from `global-css/setup-gate.css`: stock Button = cobalt pill with a
 *     white label, cobalt focus rings, visible white-alpha hairlines, the
 *     solid text tiers, AND the pre-shell type scale.
 */

import { type JSX, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";

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
  return (
    <main
      data-vex-onboarding="true"
      data-vex-gate="true"
      data-vex-screen={screen}
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden px-6 py-16 text-[var(--color-text-primary)]"
    >
      {/* THE PLATE — identical paint stack to the SetupGate curtain, so
       * the curtain reveal opens onto the same color it was made of. */}
      <div aria-hidden className="vex-gate-plate absolute inset-0" />
      <div aria-hidden className="vex-gate-vignette absolute inset-0" />
      <div aria-hidden className="vex-noise pointer-events-none absolute inset-0" />

      {/* Corner chrome — the mark alone top-left (owner decree 2026-07-22:
       * no "VEX" wordmark text beside it), version bottom-right. */}
      <div className="pointer-events-none absolute left-6 top-6 z-10">
        <img
          src="/logo_clean.png"
          alt=""
          aria-hidden
          draggable={false}
          className="h-7 w-7 select-none object-contain"
        />
      </div>
      <span className="pointer-events-none absolute bottom-7 right-10 z-10 vex-micro text-[var(--color-text-muted)]">
        v{__VEX_APP_VERSION__}
      </span>

      {/* THE PAGE COLUMN — with the container card retired (AMENDMENT A3,
       * boxless composition) this column IS the page: content sits
       * directly on the plate and the COLUMN scrolls when tall (no inner
       * scroll wells anywhere beneath). */}
      <div
        className={cn(
          "vex-gate-page relative z-10 flex max-h-full w-full flex-col",
          maxWidth === "lg" ? "max-w-[640px]" : "max-w-[560px]",
        )}
      >
        {title !== undefined ? (
          <header className="vex-rise mb-6 flex flex-col gap-2">
            <h1 className="font-serif text-2xl font-normal leading-tight text-[var(--color-text-primary)]">
              {title}
            </h1>
            {subline !== undefined ? (
              <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
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
