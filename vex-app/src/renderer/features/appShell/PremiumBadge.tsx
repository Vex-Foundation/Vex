/**
 * PremiumBadge — the mission/plan status key (DESK RULE header cluster +
 * dialog headers).
 *
 * Default (`interactive`, the omitted case): a real `<button type="button">`
 * that opens a dialog — it carries `aria-haspopup`, `aria-expanded`, and a
 * descriptive `aria-label` so the keyboard + screen reader flow reads
 * "Mission ready — open details" → Enter → focus moves into the dialog → ESC
 * returns focus.
 *
 * `interactive={false}`: a presentational `<span>` with the SAME visual grammar
 * (icon + label + caption, tone border) but NO button affordances — no
 * `onClick`, no popup/expanded semantics, no focus ring, not in the tab order.
 * Used inside an already-open dialog header as a status marker, where a
 * focusable control that does nothing would be a dead focus target.
 *
 * Two geometries, one grammar:
 *   - full (default): rounded-lg, icon + stacked label/caption — the dialog
 *     headers' status marker. Larger than `Stamp` but the same NOTARY token
 *     grammar as `MissionContractCardSections.headerMeta`.
 *   - `compact`: an h-7 pill for the DESK RULE header cluster — a still
 *     ledger tick + label + caption on one line (no icon). Pills are the
 *     landing's button silhouette; the tick is the notary mark shared with
 *     `Stamp` and it is STILL (pulsing dots are retired shell-wide — state
 *     is color + words, never looping motion).
 * Both keep a hairline tone border with text in the tone, never a filled
 * chip. Color carries meaning; neutrals carry the rest.
 *
 * Shimmer (the opacity pulse defined in globals.css as `.vex-badge--shimmer`)
 * is applied ONLY in the `ready` state, and only when the caller opts in via
 * `shimmer`. The pulse is "awaiting your action" — it stops the moment the
 * badge leaves `ready` (e.g. on accept). Reduced motion collapses it to a
 * static frame (global rule). The contract holds for both geometries.
 */

import type { ComponentType, JSX } from "react";
import {
  type GlyphProps,
  IconCircleAlert,
  IconCircleCheck,
  IconInfo,
  IconTarget,
} from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";

export type PremiumBadgeState =
  | "preparing"
  | "ready"
  | "accepted"
  | "stale"
  | "error";

interface PremiumBadgeBaseProps {
  /** Primary line (e.g. "Mission", "Plan"). */
  readonly label: string;
  readonly state: PremiumBadgeState;
  /** Optional leading icon — defaults to the per-state icon. Full variant
   * only; the compact pill renders a ledger tick instead. */
  readonly icon?: ComponentType<GlyphProps>;
  /** Opt-in to the "ready" opacity pulse. Ignored unless state === "ready". */
  readonly shimmer?: boolean;
  /** h-7 single-line header pill (tick + label + caption) instead of the
   * full rounded-lg card. Defaults to false. */
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
  /** Short status caption rendered beneath the label. */
  readonly caption: string;
  /** Border + text tone (the only color the badge carries). */
  readonly toneClass: string;
  readonly iconClass: string;
  /** Compact-pill ledger-tick fill — the same tone as the icon/text. */
  readonly markClass: string;
  /** Default per-state icon (overridable via the `icon` prop). */
  readonly icon: ComponentType<GlyphProps>;
  readonly dataState: string;
}

function stateMeta(state: PremiumBadgeState): StateMeta {
  switch (state) {
    case "preparing":
      return {
        caption: "Preparing",
        toneClass:
          "border-line-3 text-ink-tertiary hover:border-line-3",
        iconClass: "text-ink-tertiary",
        markClass: "bg-ink-tertiary",
        icon: IconTarget,
        dataState: "preparing",
      };
    case "ready":
      return {
        caption: "Ready",
        toneClass:
          "border-accent-primary/55 text-accent-primary hover:bg-accent-primary/8",
        iconClass: "text-accent-primary",
        markClass: "bg-accent-primary",
        icon: IconInfo,
        dataState: "ready",
      };
    case "accepted":
      return {
        caption: "Accepted",
        toneClass:
          "border-success/40 text-success hover:bg-success/8",
        iconClass: "text-success",
        markClass: "bg-success",
        icon: IconCircleCheck,
        dataState: "accepted",
      };
    case "stale":
      return {
        caption: "Review again",
        toneClass:
          "border-warning/40 text-warning hover:bg-warning/8",
        iconClass: "text-warning",
        markClass: "bg-warning",
        icon: IconInfo,
        dataState: "stale",
      };
    case "error":
      return {
        caption: "Action needed",
        toneClass:
          "border-warning/40 text-warning hover:bg-warning/8",
        iconClass: "text-warning",
        markClass: "bg-warning",
        icon: IconCircleAlert,
        dataState: "error",
      };
  }
}

/** Full layout (icon + stacked label/caption) — identical for both
 * interactive variants. */
const BADGE_LAYOUT =
  "group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left";

/** Compact layout — the DESK RULE header pill: ledger tick + label +
 * caption on one h-7 line (the landing's pill silhouette). */
const COMPACT_LAYOUT =
  "group inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3";

export function PremiumBadge(props: PremiumBadgeProps): JSX.Element {
  const { label, state, icon, shimmer = false, compact = false } = props;
  const meta = stateMeta(state);
  const Icon = icon ?? meta.icon;
  const showShimmer = shimmer && state === "ready";

  const inner = compact ? (
    <>
      {/* Still LEDGER TICK — the notary mark shared with `Stamp` (the
       * selection beam's bar at stamp scale). Never a pulsing loop (pulse
       * dots are retired shell-wide); "awaiting your action" is carried by
       * the shimmer contract instead. */}
      <span
        aria-hidden
        className={cn("h-2.5 w-[2px] shrink-0 rounded-full", meta.markClass)}
      />
      <span className="vex-micro font-medium text-ink-primary">{label}</span>
      <span className="vex-micro">{meta.caption}</span>
    </>
  ) : (
    <>
      <Icon size={16} className={cn("shrink-0", meta.iconClass)} />
      <span className="flex min-w-0 flex-col gap-0.5">
        {/* Register: the key's name is a sans small-caps micro-label
         * (white); the state caption beneath carries the tone. Mono
         * uppercase is retired shell-wide (landing-motifs.css). */}
        <span className="vex-micro truncate font-medium text-ink-primary">
          {label}
        </span>
        <span className="vex-micro">{meta.caption}</span>
      </span>
    </>
  );

  const layoutClass = compact ? COMPACT_LAYOUT : BADGE_LAYOUT;

  // Presentational status marker — a `<span>`, not a focus target. Used inside
  // an already-open dialog header where a clickable control would do nothing.
  if (props.interactive === false) {
    return (
      <span
        data-vex-state={meta.dataState}
        className={cn(
          layoutClass,
          meta.toneClass,
          showShimmer && "vex-badge--shimmer",
        )}
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
      aria-label={`${label} ${meta.caption.toLowerCase()} — open details`}
      data-vex-state={meta.dataState}
      data-vex-action="open-mission-detail"
      className={cn(
        layoutClass,
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
        meta.toneClass,
        showShimmer && "vex-badge--shimmer",
      )}
    >
      {inner}
    </button>
  );
}
