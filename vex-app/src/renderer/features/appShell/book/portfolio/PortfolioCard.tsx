/**
 * PortfolioCard — the ONE tokens-v2 card chrome every BOOK card composes
 * (Portfolio Overview / Wallets / Balances / the session cards): a SOLID
 * layer-1 surface with an alpha hairline border and the lv1 elevation shadow
 * (celeris separates by border + shadow on white; chronos by the luminance
 * ladder + white-alpha border — both come free from the aliases). The micro-label
 * eyebrow is the card's dot-matrix signature voice.
 *
 * Each card is a `motion.section` riding the shared `cardVariants`, so the
 * panel's stack stagger (delayChildren/staggerChildren on `stackVariants`)
 * cascades the cards as one gesture without per-card wiring.
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
      className="relative shrink-0 overflow-hidden rounded-xl border border-line-2 bg-surface-1 p-4 shadow-lv1"
    >
      <header className="mb-2.5 flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {leading}
          <h3 className="vex-micro-label vex-micro-label--wide uppercase text-ink-secondary">
            {eyebrow}
          </h3>
        </span>
        {trailing !== undefined ? (
          <span className="text-[11px] tabular-nums text-ink-tertiary">
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
 * card's micro-label voice; `warn` uses the token warn label; `muted` is the
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
      <p className="vex-micro-label uppercase text-ink-secondary">
        {children}
      </p>
    );
  }
  return (
    <p
      className={
        tone === "warn"
          ? "text-[12px] text-warning-label"
          : "text-[12px] leading-relaxed text-ink-tertiary"
      }
    >
      {children}
    </p>
  );
}
