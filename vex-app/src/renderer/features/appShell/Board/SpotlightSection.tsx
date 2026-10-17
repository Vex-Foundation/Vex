/**
 * THE SPOTLIGHT SECTION - the one head every block under the hero wears
 * (docs/design/R3-MINIMAL.md sections 1.3 and 9.4).
 *
 * Section = head + body. The head is the page's `.sec-h`: a 15 / 600 title at
 * the left, a 12.5 muted meta at the right, optionally one trailing action,
 * over a 1px rule with 6px under the words. There is no frame, no card fill
 * and no icon: the page is paper and the rule is the only line.
 *
 * ONE LEVEL OF LINE. The page holds sections; a section holds a head rule and
 * quiet row rules. Nothing inside a section draws a box.
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

export interface SpotlightSectionProps {
  readonly area: string;
  readonly title: string;
  /** Right-hand meta: a figure pair, a window label, a chip. */
  readonly meta?: ReactNode;
  /** One trailing header action (the assessment's Ask Vex). */
  readonly action?: ReactNode;
  /** Passed through as `data-state` for the tests that key on it. */
  readonly state?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function SpotlightSection({
  area,
  title,
  meta,
  action,
  state,
  className,
  children,
}: SpotlightSectionProps): JSX.Element {
  return (
    <section
      data-vex-area={area}
      data-state={state}
      className={cn("flex min-w-0 flex-col", className)}
    >
      {/* THE HEAD WRAPS RATHER THAN CUTS. A column can be as narrow as 300px
        * and a meta such as "Checks unavailable in this response" is a whole
        * sentence; dropping to a second line keeps every word. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule pb-1.5">
        <h3 className="min-w-0 text-[15px] font-semibold leading-[1.3] text-ink-primary">
          {title}
        </h3>
        {meta === undefined ? null : (
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[12.5px] leading-[1.3] text-ink-tertiary">
            {meta}
          </span>
        )}
        {action === undefined ? null : (
          <span className={cn("flex shrink-0 items-center", meta === undefined && "ml-auto")}>
            {action}
          </span>
        )}
      </div>
      <div className="mt-2.5 flex min-w-0 flex-col">{children}</div>
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
      className={cn("h-[52px] w-full bg-surface-skeleton", className)}
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
    <p data-state="unavailable" className="text-[14px] leading-[1.45] text-ink-tertiary">
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
