/**
 * PortfolioCard - the ONE card chrome every BOOK card composes (Portfolio
 * Overview / Wallets / Balances / the session and project cards): the GLASS
 * CARD tier (`.vex-glass-card`, styles/global-css/glass.css; owner decision
 * 2026-09-04: the Settings glaze on every plain card). Inside a BOOK rail the
 * rail blurs the wall and the card is a tinted plate over it; in the welcome
 * Portfolio stack, with no rail under it, the same class blurs for itself.
 * Edge light and a hairline ring stand in for the stroke the solid card had;
 * both themes repoint the same tint tokens. The micro-label eyebrow is the
 * card's dot-matrix signature voice.
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
      className="vex-glass-card relative shrink-0 overflow-hidden rounded-xl p-4"
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

/**
 * Key/value row of the metadata cards (SESSION, PROJECT): muted label, stronger
 * tabular value, hairline-separated. ONE primitive for both cards so the
 * project rail's card and the session rail's card are the same row to the
 * eye; `title` carries the whole value for a row that truncates (a path).
 */
export function CardKeyValueRow({
  label,
  title,
  children,
}: {
  readonly label: string;
  readonly title?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-1 py-1.5 last:border-b-0 last:pb-0.5">
      <span className="text-[10.5px] text-ink-tertiary">{label}</span>
      <span
        className="min-w-0 truncate text-right text-[11.5px] tabular-nums text-ink-primary"
        title={title}
      >
        {children}
      </span>
    </div>
  );
}
