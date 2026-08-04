/**
 * PortfolioCard — the ONE Chronos glass chrome for the welcome Portfolio
 * tab's floating cards (Portfolio Overview / Wallets / Balances): ink glass
 * matched to the current shell backdrop (`--vex-rail`) + backdrop-blur
 * (design-guard whitelisted for exactly this file), the static
 * `.vex-noise--panel` grain, a `--vex-line` hairline border, rounded-2xl.
 * Every card in the stack composes this wrapper and NO other portfolio file
 * may carry backdrop-blur (the HvZone precedent: one whitelisted wrapper
 * per glass family, so the guard stays a single conscious entry).
 *
 * Each card is a `motion.section` riding the shared `cardVariants`, so the
 * panel's stack stagger (delayChildren/staggerChildren on `stackVariants`)
 * cascades the cards as one gesture without per-card wiring. `isolate`
 * guarantees a stacking context in the SETTLED state too (once the spring
 * lands, motion may drop the transform that was creating one), so the
 * `-z-10` grain always paints above the glass tint and below the content.
 */

import type { JSX, ReactNode } from "react";
import { motion } from "motion/react";
import { cardVariants } from "./portfolio-motion.js";

export function PortfolioCard({
  eyebrow,
  leading,
  trailing,
  children,
}: {
  readonly eyebrow: string;
  /** Optional mark rendered before the eyebrow (e.g. a venue's protocol logo). */
  readonly leading?: ReactNode;
  /** Optional right-aligned header datum (e.g. the wallet count). */
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <motion.section
      variants={cardVariants}
      aria-label={eyebrow}
      // shrink-0: inside the height-constrained scrollable stack a card must
      // NEVER be flex-squashed — a few compressed px let overflow-hidden
      // slice the last row ("Add wallet" / "View all assets"; owner
      // screenshot 2026-07-21). Overflow belongs to the stack's scroll, not
      // to card compression.
      className="relative isolate shrink-0 overflow-hidden rounded-2xl border border-[var(--vex-line)] bg-[var(--vex-rail)] p-4 backdrop-blur-xl"
    >
      <div
        aria-hidden
        className="vex-noise vex-noise--panel pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"
      />
      <header className="mb-2.5 flex items-baseline justify-between gap-2">
        {/* Landing eyebrow grammar — the same section-head voice as the
         * session rail's BookBlock. */}
        <span className="flex min-w-0 items-center gap-2">
          {leading}
          <h3 className="vex-eyebrow">{eyebrow}</h3>
        </span>
        {trailing !== undefined ? (
          <span className="font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
            {trailing}
          </span>
        ) : null}
      </header>
      {children}
    </motion.section>
  );
}

/**
 * Quiet state line for a card body (loading / empty / error) — factual and
 * never louder than the content it stands in for. `loading` speaks the
 * rail's mono micro-voice; `warn` uses the token warn text; `muted` is the
 * default informational tone (empty states phrase an invitation, not a
 * mood).
 */
export function CardStateNote({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "warn" | "loading";
  readonly children: ReactNode;
}): JSX.Element {
  if (tone === "loading") {
    return (
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
        {children}
      </p>
    );
  }
  return (
    <p
      className={
        tone === "warn"
          ? "text-[12px] text-[var(--vex-warn-text)]"
          : "text-[12px] leading-relaxed text-[var(--vex-text-3)]"
      }
    >
      {children}
    </p>
  );
}
