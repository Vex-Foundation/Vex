/**
 * A single dense ledger row (48px): mode glyph, two text lines (title +
 * time/activity, subtitle + exception stamps), hairline-separated — no card
 * box, no resting glow. Selection is the landing's workspace beam
 * (`.vex-select-beam`, globals.css): a cobalt gradient sweep with a white
 * ledger bar on the left edge, text lifted to white (stamps flip to
 * white-ink via `onBeam` so they stay legible on the gradient).
 * Mode/permission badge pairs are gone: the glyph already says mode, and
 * stamps appear only when state deviates from the default (restricted /
 * live / paused — terminal sessions earn silence).
 *
 * The row-select control and the row actions (trash + pin) are SIBLINGS
 * inside a non-interactive wrapper — never nested buttons — so Enter/Space
 * on an action cannot bubble into row selection.
 */

import type { JSX, MouseEvent } from "react";
import {
  AiChat01Icon,
  Target02Icon,
  VexIcon,
} from "../../../components/icons/index.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { cn } from "../../../lib/utils.js";
import {
  formatSessionTime,
  getMissionActivity,
  getSessionSubtitle,
  getSessionTitle,
} from "../sessionListModel.js";
import { Stamp } from "./Stamp.js";
import { RemoveButton } from "./RemoveButton.js";
import { PinToggle } from "./PinToggle.js";

export function SessionRow({
  row,
  selected,
  sidebarOpen,
  onSelect,
  onTogglePin,
  onRequestRemove,
  pinPending,
}: {
  readonly row: SessionListItem;
  readonly selected: boolean;
  readonly sidebarOpen: boolean;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  readonly pinPending: boolean;
}): JSX.Element {
  const startedLabel = formatSessionTime(row.startedAt);
  const title = getSessionTitle(row);
  const subtitle = getSessionSubtitle(row);
  const activity = getMissionActivity(row);
  const Icon = row.mode === "mission" ? Target02Icon : AiChat01Icon;
  const isPinned = row.pinnedAt !== null;

  const handlePinClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    if (pinPending) return;
    onTogglePin(row.id, !isPinned);
  };

  const handleRemoveClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    onRequestRemove(row);
  };

  // Row select control and pin toggle are SIBLINGS inside a non-interactive
  // wrapper. This is the only safe layout: a button inside a button is
  // invalid HTML, and a custom `role="button"` parent would let Enter/Space
  // bubble from the pin into a row-level keydown handler. Container holds
  // the visual styling; both children focus / click independently.
  return (
    <li className="border-b border-[var(--vex-line)] last:border-b-0">
      <div
        className={cn(
          "group relative flex w-full transition-colors",
          // Selection = the landing beam (accent gradient + ledger bar,
          // globals.css `.vex-select-beam`); hover stays a quiet surface lift.
          // Text on the beam reads `--vex-accent-contrast` (white on cobalt,
          // ink on a light accent beam), never a raw white.
          selected
            ? "vex-select-beam text-[var(--vex-accent-contrast)]"
            : "hover:bg-white/[0.035]",
          // Fixed height drives the fit-to-height packer; see
          // SIDEBAR_ROW_HEIGHT_PX in sessionListLayout.ts.
          sidebarOpen ? "h-12" : "h-11",
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(row.id)}
          aria-current={selected ? "true" : undefined}
          aria-label={!sidebarOpen ? title : undefined}
          className={cn(
            "flex h-full w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
            // Actions-take-priority hover (Chronos): at rest the title owns
            // the full width; the moment the row is hovered/focused, pr-14
            // reserves the right slot for the Trash + Pin sibling cluster and
            // the title truncates earlier (the timestamp yields — see the
            // group-hover:opacity-0 on the right-slot spans below). The
            // padding swap is deliberately instant (no transition) so the
            // truncation never smears mid-reflow. Collapsed sidebar hides
            // both actions, so no reservation.
            sidebarOpen
              ? "items-center gap-2.5 px-2.5 group-focus-within:pr-14 group-hover:pr-14"
              : "items-center justify-center px-0",
          )}
          title={sidebarOpen ? undefined : title}
        >
          <span
            className={cn(
              "relative flex h-7 w-7 shrink-0 items-center justify-center",
              selected
                ? "text-[var(--vex-accent-contrast)]"
                : "text-[var(--vex-text-3)]",
            )}
          >
            <VexIcon icon={Icon} size={15} aria-hidden />
            {!sidebarOpen && activity !== null ? (
              <span
                aria-hidden
                className={cn(
                  "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-black/60",
                  // On the selected beam the tone dot flips to the beam's
                  // contrast ink (white on cobalt, ink on lime) — an accent dot
                  // would vanish into the gradient.
                  selected ? "bg-[var(--vex-accent-contrast)]" : activity.dotClass,
                )}
              />
            ) : null}
          </span>

          {sidebarOpen ? (
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px] font-medium",
                    selected ? "text-[var(--vex-accent-contrast)]" : "text-foreground",
                  )}
                >
                  {title}
                </span>
                {/* Owner decree — no pulsing dots anywhere: the right slot
                 * ALWAYS shows the timestamp now. A running mission's signal
                 * lives entirely in the "live" Stamp on the subtitle line
                 * below, so dropping the dot loses no information. */}
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
                    selected
                      ? "text-[color-mix(in_oklab,var(--vex-accent-contrast)_80%,transparent)]"
                      : "text-[var(--vex-text-2)]",
                  )}
                >
                  {startedLabel}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[11px]",
                    // Metadata line: text-3 at rest (quiet ledger), lifted to
                    // the beam's contrast ink at 85% so it stays legible on the
                    // gradient in both themes.
                    selected
                      ? "text-[color-mix(in_oklab,var(--vex-accent-contrast)_85%,transparent)]"
                      : "text-[var(--vex-text-3)]",
                  )}
                >
                  {subtitle}
                </span>
                {row.permission !== "full" ? (
                  <Stamp tone="warn" onBeam={selected}>restricted</Stamp>
                ) : null}
                {activity?.tone === "active" ? (
                  <Stamp tone="accent" onBeam={selected}>live</Stamp>
                ) : null}
                {activity?.tone === "paused" ? (
                  <Stamp tone="warn" onBeam={selected}>paused</Stamp>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>

        {sidebarOpen ? (
          // Trash + Pin live in a sibling cluster outside the select
          // button. Native buttons inside a non-interactive wrapper —
          // no nested buttons, no role="button" parent, so Enter/Space
          // on either action cannot bubble into a row-select handler.
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <RemoveButton onClick={handleRemoveClick} />
            <PinToggle
              pinned={isPinned}
              pending={pinPending}
              onClick={handlePinClick}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}
