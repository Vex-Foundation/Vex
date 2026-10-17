/**
 * PortfolioCard: the ONE section chrome every Portfolio page section composes
 * (Wallets, Balances, Lighter account, Activity, Launchpad), per
 * docs/design/R3-MINIMAL.md section 9.1: a head with the section's name in
 * Instrument Sans 15 / 600, an optional muted note after it, and the
 * section's link at the right (13 / 500 blue); then the body, usually a
 * table. No box, no fill, no radius, no shadow: the section sits on the
 * page's paper (`.vex-pf-sec`, styles/global-css/book.css).
 */

import type { JSX, MouseEvent, ReactNode } from "react";

export function PortfolioCard({
  title,
  note,
  leading,
  action,
  children,
}: {
  /** The section's name; also its accessible name. */
  readonly title: string;
  /** Muted words after the name ("not in the total above · as of 12:29"). */
  readonly note?: ReactNode;
  /** A mark before the name (the launchpad's protocol mark). */
  readonly leading?: ReactNode;
  /** The section's link or keys, at the right of the head. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section aria-label={title} className="vex-pf-sec">
      <header className="vex-pf-sec__h">
        <h2 className="vex-pf-sec__t">
          {leading}
          <span>{title}</span>
          {note !== undefined && note !== null ? (
            <span className="vex-pf-sec__note">{note}</span>
          ) : null}
        </h2>
        {action !== undefined && action !== null ? (
          <span className="vex-pf-sec__a">{action}</span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/**
 * Quiet state line for a section body (loading, empty, error): factual and
 * never louder than the content it stands in for. `warn` sets the line in ink
 * (status is never a colour); `loading` is the muted loading word; `muted` is
 * the default informational tone (an empty state phrases an invitation).
 */
export function CardStateNote({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "warn" | "loading";
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p className="vex-pf-note" data-tone={tone}>
      {children}
    </p>
  );
}

/**
 * A section head link (13 / 500 blue): a button, because it opens a page or a
 * mode inside the app. Its own rect rides along as the opened page's origin.
 */
export function SectionLink({
  onClick,
  label,
  children,
}: {
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** An accessible name when the visible word needs more context. */
  readonly label?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="vex-pf-link"
    >
      {children}
    </button>
  );
}

/** The opener's rect, the shape every route's `origin` takes. */
export function originOf(event: MouseEvent<HTMLElement>): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
