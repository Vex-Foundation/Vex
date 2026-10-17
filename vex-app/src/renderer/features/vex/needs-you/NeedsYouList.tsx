/**
 * THE NEEDS YOU LIST: what waits for the user's decision, one row per item
 * (docs/design/R3-MINIMAL.md sections 3 and 5). The title bar panel and the
 * Vex sidebar render this same list from the same model, so they cannot count
 * or word it differently; the Needs you page groups the same items.
 *
 * Every row says three things: the action in words ("Approve bridge"), where it
 * was raised and when it expires (or since when it waits), and a key. The key
 * only opens the thing: a decision is never taken from this list, the REAL
 * FUNDS approval stays in its own card with its own two-step confirm.
 *
 * Status is a fill plus a word: the target swatch for a decision, the ink cross
 * for a mission that needs Recover. An unreadable inbox says so and offers
 * Retry, an empty one says "Nothing needs you."; neither is ever drawn as the
 * other. Paper, ink, one blue, radius 0, no shadow.
 */

import type { JSX } from "react";
import { Swatch } from "../../../components/ui/swatch.js";
import { cn } from "../../../lib/utils.js";
import {
  NEEDS_YOU_EMPTY_COPY,
  NEEDS_YOU_UNKNOWN_COPY,
  type NeedsYouItem,
  type NeedsYouStatus,
} from "../needs-you.js";
import { VEX_STATE_FILL } from "../vex-state.js";

/** Where the list sits: the title bar panel, or the Vex sidebar's own section. */
export type NeedsYouListVariant = "panel" | "sidebar";

export interface NeedsYouListModel {
  readonly status: NeedsYouStatus;
  readonly items: readonly NeedsYouItem[];
  readonly retry: () => void;
  readonly retrying: boolean;
}

export interface NeedsYouListProps {
  readonly model: NeedsYouListModel;
  readonly variant: NeedsYouListVariant;
  /** Open the item: its approval card, its mission session. Never decides. */
  readonly onReview: (item: NeedsYouItem) => void;
  /** The key's word per item; defaults to the item's own ("Review", "Recover", "Open"). */
  readonly goLabel?: (item: NeedsYouItem) => string;
}

const VARIANT: Readonly<
  Record<
    NeedsYouListVariant,
    { readonly row: string; readonly title: string; readonly meta: string; readonly go: string }
  >
> = {
  panel: {
    row: "grid grid-cols-[14px_1fr_auto] items-start gap-x-2.5 gap-y-0.5 border-t border-rule-quiet px-3.5 py-[9px] first:border-t-0",
    title: "text-[14px] font-medium leading-5 text-ink-primary",
    meta: "col-start-2 text-[12.5px] leading-[18px] text-ink-tertiary",
    go: "text-[13px]",
  },
  sidebar: {
    row: "grid grid-cols-[12px_1fr_auto] items-start gap-x-[9px] py-1.5",
    title: "text-[13.5px] leading-[19px] text-ink-primary",
    meta: "col-start-2 text-[12px] leading-4 text-ink-tertiary",
    go: "text-[13px]",
  },
};

function MetaLine({ item }: { readonly item: NeedsYouItem }): JSX.Element {
  if (item.metaTime === null) return <>{item.metaLead}</>;
  return (
    <>
      {item.metaLead} <span className="font-mono tabular-nums">{item.metaTime}</span>
    </>
  );
}

export function NeedsYouList({ model, variant, onReview, goLabel }: NeedsYouListProps): JSX.Element {
  const classes = VARIANT[variant];
  const { status, items } = model;

  return (
    <div data-vex-area="needs-you-list" data-state={status} data-variant={variant}>
      {status === "loading" ? (
        <p role="status" className="text-[13.5px] text-ink-tertiary">
          Checking for pending approvals
        </p>
      ) : null}
      {status === "unknown" ? (
        <div role="status" className="flex items-start justify-between gap-3 pb-1.5">
          <p className="text-[13.5px] leading-5 text-ink-primary">{NEEDS_YOU_UNKNOWN_COPY}</p>
          <button
            type="button"
            disabled={model.retrying}
            onClick={model.retry}
            className="shrink-0 text-[13px] font-medium text-accent-primary hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:text-ink-tertiary disabled:no-underline"
          >
            {model.retrying ? "Checking" : "Retry"}
          </button>
        </div>
      ) : null}
      {status === "ready" && items.length === 0 ? (
        <p className="text-[13.5px] text-ink-tertiary">{NEEDS_YOU_EMPTY_COPY}</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {items.map((item) => {
            const go = goLabel === undefined ? item.go : goLabel(item);
            return (
              <li
                key={item.key}
                data-vex-needs-you-item={item.kind}
                className={classes.row}
              >
                <span className="mt-1">
                  <Swatch
                    state={item.kind === "recover" ? VEX_STATE_FILL.error : VEX_STATE_FILL.awaiting}
                    size={10}
                  />
                </span>
                <span className={classes.title}>{item.title}</span>
                <button
                  type="button"
                  aria-label={`${go}: ${item.title}`}
                  onClick={() => {
                    onReview(item);
                  }}
                  className={cn(
                    "font-medium text-accent-primary hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    classes.go,
                  )}
                >
                  {go}
                </button>
                <span className={classes.meta}>
                  <MetaLine item={item} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
