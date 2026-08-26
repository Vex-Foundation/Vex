/**
 * THE SPOTLIGHT SECTION - the one frame every block under the hero wears.
 *
 * Section = label + content. The header is an 18px BARE glyph in the
 * tertiary ink (positive and danger tones repoint it), a 14/20 semibold
 * title, and a right-hand meta in the 12/16 tertiary register, optionally
 * followed by one trailing action. There is no disc, no medallion and no
 * wash behind the glyph: an icon is coloured by the row's ink and sits in
 * its leading slot, which is the whole of the reference set's icon language.
 *
 * ONE LEVEL OF FRAME. The plate holds sections; a section holds hairline
 * dividers and borderless grids. Nothing inside a section draws another
 * rounded, bordered or filled box - the card-in-card the previous design
 * shipped is exactly what this file exists to prevent.
 *
 * THREE DESIGNED STATES for a section over a channel read. Pending draws the
 * skeleton register, unavailable prints the sentence for the reason, and the
 * body is only ever called with a value in hand. Every read-backed section
 * goes through {@link SpotlightReadSection}, so no section can quietly grow a
 * fourth state that says nothing.
 */

import type { JSX, ReactNode } from "react";
import { cn } from "../../../lib/utils.js";
import type { SpotlightRead } from "./spotlight-channels.js";

/**
 * What the reader is told when a read produced nothing usable.
 *
 * One sentence per reason, and the two families stay apart: `unknown_pair` is
 * settled (asking again answers the same way) while the rest are unknown. A
 * single "unavailable" for both would tell a reader to keep waiting for an
 * answer that will never differ.
 */
export const UNAVAILABLE_COPY: Readonly<Record<string, string>> = {
  transport: "Could not reach the provider for this read.",
  provider: "The provider did not answer this read.",
  busy: "The board is busy with other reads. This one is retried.",
  not_mounted: "This read is not available in this build.",
  cancelled: "This read was cancelled.",
  unknown_pair: "The provider does not index this pool.",
};

export function unavailableCopy(reason: string): string {
  return UNAVAILABLE_COPY[reason] ?? "Unavailable in this response.";
}

export type SpotlightSectionTone = "neutral" | "positive" | "danger";

const ICON_TONE: Readonly<Record<SpotlightSectionTone, string>> = {
  neutral: "text-ink-tertiary",
  positive: "text-success",
  danger: "text-danger",
};

export interface SpotlightSectionProps {
  readonly area: string;
  readonly icon: ReactNode;
  readonly title: string;
  /** Right-hand meta: a figure pair, a window label, a chip. */
  readonly meta?: ReactNode;
  /** One trailing header action (the assessment's Ask VEX). */
  readonly action?: ReactNode;
  readonly tone?: SpotlightSectionTone;
  /** Passed through as `data-state` for the tests that key on it. */
  readonly state?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function SpotlightSection({
  area,
  icon,
  title,
  meta,
  action,
  tone = "neutral",
  state,
  className,
  children,
}: SpotlightSectionProps): JSX.Element {
  return (
    <section
      data-vex-area={area}
      data-state={state}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-2xl border border-line-2 bg-board-card p-4",
        className,
      )}
    >
      <div className="flex h-6 items-center gap-2.5">
        <span
          aria-hidden
          data-vex-area="board-spotlight-section-icon"
          className={cn("flex shrink-0 items-center", ICON_TONE[tone])}
        >
          {icon}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-[20px] text-ink-primary">
          {title}
        </h3>
        {meta === undefined ? null : (
          <span className="flex shrink-0 items-center text-[12px] leading-[16px] tabular-nums text-ink-tertiary">
            {meta}
          </span>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

/** The skeleton a section's body wears while its read is in flight. */
export function SpotlightPendingBody({
  title,
  className,
}: {
  readonly title: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <p
      data-state="pending"
      aria-label={`${title} loading`}
      className={cn(
        "h-[52px] w-full rounded bg-surface-skeleton animate-pulse motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/** The sentence a section's body carries when its read produced nothing. */
export function SpotlightUnavailableBody({
  reason,
}: {
  readonly reason: string;
}): JSX.Element {
  return (
    <p data-state="unavailable" className="text-[13px] leading-[18px] text-ink-tertiary">
      {unavailableCopy(reason)}
    </p>
  );
}

export interface SpotlightReadSectionProps<T>
  extends Omit<SpotlightSectionProps, "children"> {
  readonly read: SpotlightRead<T>;
  readonly children: (value: T) => ReactNode;
}

/**
 * A section over one channel read, with its three designed states in one
 * place. The body is only ever called with a value in hand.
 */
export function SpotlightReadSection<T>({
  read,
  children,
  ...section
}: SpotlightReadSectionProps<T>): JSX.Element {
  return (
    <SpotlightSection {...section}>
      {read.status === "pending" ? (
        <SpotlightPendingBody title={section.title} />
      ) : read.status === "unavailable" ? (
        <SpotlightUnavailableBody reason={read.reason} />
      ) : (
        children(read.value)
      )}
    </SpotlightSection>
  );
}
