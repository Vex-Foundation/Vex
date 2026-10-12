/**
 * PortfolioCard - the ONE section chrome every BOOK section composes
 * (Position / Wallets / Balances / the session and project sections): a
 * Departure Mono label row, then hairline ledger rows, divided from its
 * neighbours by one rule (`.vex-bs`, styles/global-css/book.css; docs/design/
 * V10-SPREAD.md sections 1 and 2). No box, no fill, no radius: the section
 * sits on the paper of the page.
 *
 * Each section is a `motion.section` riding the shared `cardVariants`, so the
 * panel's stack stagger (delayChildren/staggerChildren on `stackVariants`)
 * cascades the sections as one gesture without per-section wiring.
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
      // A section never flex-squashes: inside the height-constrained scrollable
      // stack a few compressed px would slice the last row ("Add wallet" /
      // "View all assets"). Overflow belongs to the stack's scroll.
      className="vex-bs"
    >
      <header className="vex-bs__h">
        {leading}
        <h3 className="vex-bs__t">{eyebrow}</h3>
        {trailing !== undefined ? (
          <span className="vex-bs__m">{trailing}</span>
        ) : null}
      </header>
      {children}
    </motion.section>
  );
}

/**
 * Quiet state line for a section body (loading / empty / error) — factual and
 * never louder than the content it stands in for. `loading` speaks the
 * label voice (mono caps); `warn` sets the line in ink, since status is never
 * a colour; `muted` is the default informational tone (empty states phrase an invitation, not a
 * mood).
 */
export function CardStateNote({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "warn" | "loading";
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p className="vex-bs__empty" data-tone={tone}>
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
    <div className="vex-kv">
      <span>{label}</span>
      <span title={title}>{children}</span>
    </div>
  );
}
