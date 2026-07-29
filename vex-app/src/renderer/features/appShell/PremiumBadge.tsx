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
 *   - `compact`: an h-7 mono pill for the DESK RULE header cluster — a still
 *     status dot + label + caption on one line (no icon). Pills are the
 *     landing's button silhouette; the dot is STILL (pulsing dots are retired
 *     shell-wide — state is color + words, never looping motion).
 * Both keep a hairline tone border with text in the tone, never a filled
 * chip. Color carries meaning; neutrals carry the rest.
 *
 * Shimmer (the opacity pulse defined in globals.css as `.vex-badge--shimmer`)
 * is applied ONLY in the `ready` state, and only when the caller opts in via
 * `shimmer`. The pulse is "awaiting your action" — it stops the moment the
 * badge leaves `ready` (e.g. on accept). Reduced motion collapses it to a
 * static frame (global rule). The contract holds for both geometries.
 */

import type { JSX } from "react";
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  type IconGlyph,
  InformationCircleIcon,
  Target02Icon,
  VexIcon,
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
   * only; the compact pill renders a status dot instead. */
  readonly icon?: IconGlyph;
  /** Opt-in to the "ready" opacity pulse. Ignored unless state === "ready". */
  readonly shimmer?: boolean;
  /** h-7 single-line header pill (dot + label + caption) instead of the
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
  /** Compact-pill status dot fill — the same tone as the icon/text. */
  readonly dotClass: string;
  /** Default per-state icon (overridable via the `icon` prop). */
  readonly icon: IconGlyph;
  readonly dataState: string;
}

function stateMeta(state: PremiumBadgeState): StateMeta {
  switch (state) {
    case "preparing":
      return {
        caption: "Preparing",
        toneClass:
          "border-[var(--vex-line-strong)] text-[var(--vex-text-3)] hover:border-[var(--vex-line-strong)]",
        iconClass: "text-[var(--vex-text-3)]",
        dotClass: "bg-[var(--vex-text-3)]",
        icon: Target02Icon,
        dataState: "preparing",
      };
    case "ready":
      return {
        caption: "Ready",
        toneClass:
          "border-[var(--vex-accent-border)] text-[var(--vex-accent-text)] hover:bg-[var(--vex-accent-fill-8)]",
        iconClass: "text-[var(--vex-accent-text)]",
        dotClass: "bg-[var(--vex-accent)]",
        icon: InformationCircleIcon,
        dataState: "ready",
      };
    case "accepted":
      return {
        caption: "Accepted",
        toneClass:
          "border-[color-mix(in_oklab,var(--color-success)_40%,transparent)] text-success hover:bg-[color-mix(in_oklab,var(--color-success)_8%,transparent)]",
        iconClass: "text-success",
        dotClass: "bg-success",
        icon: CheckmarkCircle02Icon,
        dataState: "accepted",
      };
    case "stale":
      return {
        caption: "Review again",
        toneClass:
          "border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)] text-warning hover:bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)]",
        iconClass: "text-warning",
        dotClass: "bg-warning",
        icon: InformationCircleIcon,
        dataState: "stale",
      };
    case "error":
      return {
        caption: "Action needed",
        toneClass:
          "border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)] text-warning hover:bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)]",
        iconClass: "text-warning",
        dotClass: "bg-warning",
        icon: AlertCircleIcon,
        dataState: "error",
      };
  }
}

/** Full layout (icon + stacked label/caption) — identical for both
 * interactive variants. */
const BADGE_LAYOUT =
  "group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left";

/** Compact layout — the DESK RULE header pill: dot + label + caption on one
 * h-7 line (the landing's mono-uppercase pill silhouette). */
const COMPACT_LAYOUT =
  "group inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3";

export function PremiumBadge(props: PremiumBadgeProps): JSX.Element {
  const { label, state, icon, shimmer = false, compact = false } = props;
  const meta = stateMeta(state);
  const Icon = icon ?? meta.icon;
  const showShimmer = shimmer && state === "ready";

  const inner = compact ? (
    <>
      {/* Still status dot — never a pulsing loop (pulse dots are retired
       * shell-wide); "awaiting your action" is carried by the shimmer
       * contract instead. */}
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)}
      />
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-foreground">
        {label}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
        {meta.caption}
      </span>
    </>
  ) : (
    <>
      <VexIcon
        icon={Icon}
        size={16}
        aria-hidden
        className={cn("shrink-0", meta.iconClass)}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        {/* Landing register: the key's name is a mono micro-label (white),
         * the state caption beneath carries the tone. */}
        <span className="truncate font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-foreground">
          {label}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
          {meta.caption}
        </span>
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
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
        meta.toneClass,
        showShimmer && "vex-badge--shimmer",
      )}
    >
      {inner}
    </button>
  );
}
