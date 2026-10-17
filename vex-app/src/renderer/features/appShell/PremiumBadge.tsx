/**
 * PremiumBadge - the mission/plan status key (the title bar's mission badge
 * and the contract sheet's head).
 *
 * R3 (docs/design/R3-MINIMAL.md section 3): a 26 high badge, a 1px quiet
 * rule, 12.5 type, the state swatch, then "{label} · {caption}" ("Mission ·
 * Accepted"). Status by fill plus a word, never by colour: the swatch is the
 * blue form of the state, the words are ink. In the title bar the look rides
 * `.vex-tb-mission` in title-bar.css, which reads this exact child order
 * (mark, label, caption).
 *
 * Default (`interactive`, the omitted case): a real `<button type="button">`
 * that opens a dialog - it carries `aria-haspopup`, `aria-expanded`, and a
 * descriptive `aria-label` so the keyboard and screen reader flow reads
 * "Mission ready - open details", Enter, focus moves into the sheet, Escape
 * returns focus.
 *
 * `interactive={false}`: a presentational `<span>` with the SAME look but NO
 * button affordances - no `onClick`, no popup/expanded semantics, no focus
 * ring, not in the tab order. Used inside the already-open contract sheet as
 * a status marker, where a focusable control that does nothing would be a
 * dead focus target.
 *
 * Shimmer (the opacity pulse `.vex-badge--shimmer`) is applied ONLY in the
 * `ready` state, and only when the caller opts in via `shimmer`. The pulse is
 * "awaiting your action" - it stops the moment the badge leaves `ready`.
 * Reduced motion collapses it to a static frame (global rule).
 */

import type { JSX } from "react";
import { Swatch, type SwatchState } from "../../components/ui/swatch.js";
import { cn } from "../../lib/utils.js";

export type PremiumBadgeState =
  | "preparing"
  | "ready"
  | "accepted"
  | "stale"
  | "error"
  | "ended";

interface PremiumBadgeBaseProps {
  /** Primary word (e.g. "Mission", "Legacy plan"). */
  readonly label: string;
  readonly state: PremiumBadgeState;
  /** Opt-in to the "ready" opacity pulse. Ignored unless state === "ready". */
  readonly shimmer?: boolean;
  /**
   * The title bar's call site. R3 draws one geometry everywhere (section 3),
   * so this changes nothing; it stays so the title bar names its badge.
   */
  readonly compact?: boolean;
}

/**
 * Discriminated on `interactive` so the presentational span variant can omit
 * `onClick`/`expanded` while the default button variant still requires the
 * click handler. `interactive` defaults to `true` (the rail's clickable key).
 */
export type PremiumBadgeProps =
  | (PremiumBadgeBaseProps & {
      readonly interactive?: true;
      readonly onClick: () => void;
      /** Whether the dialog the badge controls is currently open. */
      readonly expanded?: boolean;
    })
  | (PremiumBadgeBaseProps & {
      readonly interactive: false;
    });

interface StateMeta {
  /** The state in words, after the label. */
  readonly caption: string;
  /** The fill (section 1.6). */
  readonly swatch: SwatchState;
}

/**
 * Words and fills per state: the dot screen while Vex prepares the contract,
 * the target while it waits for the user, solid once accepted or ended, the
 * ink hatch when it needs another look, the ink cross when the run paused on
 * an error (the same words the run strip and the token chip use).
 */
const STATE_META: Readonly<Record<PremiumBadgeState, StateMeta>> = {
  preparing: { caption: "Preparing", swatch: "listening" },
  ready: { caption: "Ready", swatch: "awaiting" },
  accepted: { caption: "Accepted", swatch: "done" },
  stale: { caption: "Review again", swatch: "concerned" },
  error: { caption: "Paused on error", swatch: "error" },
  ended: { caption: "Ended", swatch: "done" },
};

/** One look for both variants (section 3 and the contract sheet head). */
const BADGE_LAYOUT =
  "inline-flex h-[26px] shrink-0 items-center gap-2 whitespace-nowrap border border-rule-quiet bg-transparent px-[9px] text-[12.5px] leading-none text-ink-primary";

export function PremiumBadge(props: PremiumBadgeProps): JSX.Element {
  const { label, state, shimmer = false } = props;
  const meta = STATE_META[state];
  const showShimmer = shimmer && state === "ready";

  // Child order is load-bearing: title-bar.css styles the first span as the
  // mark and adds the " ·" after the second.
  const inner = (
    <>
      <Swatch state={meta.swatch} size={10} className="text-accent-primary" />
      <span className="after:text-ink-tertiary after:content-['_·']">{label}</span>
      <span>{meta.caption}</span>
    </>
  );

  // Presentational status marker - a `<span>`, not a focus target. Used inside
  // an already-open sheet head where a clickable control would do nothing.
  if (props.interactive === false) {
    return (
      <span
        data-vex-state={state}
        className={cn(BADGE_LAYOUT, showShimmer && "vex-badge--shimmer")}
      >
        {inner}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-haspopup="dialog"
      aria-expanded={props.expanded ?? false}
      aria-label={`${label} ${meta.caption.toLowerCase()} - open details`}
      data-vex-state={state}
      data-vex-action="open-mission-detail"
      className={cn(
        BADGE_LAYOUT,
        "enabled:hover:bg-interactive-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        showShimmer && "vex-badge--shimmer",
      )}
    >
      {inner}
    </button>
  );
}
