/**
 * Hover-card body for a session row (docs/design/R3-MINIMAL.md sections 4
 * and 12): the FULL title (the row truncates), the start time, the mode with
 * the facts that deviate from the default (a restricted permission, the run's
 * state word), and, where the row can be renamed, the line that says how the
 * row's keys work. The card is the field with one ink rule, so the inks are
 * the theme labels.
 */

import type { JSX } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { getSessionTitle } from "../sessionListModel.js";
import { sessionRowState } from "./session-row-state.js";

/** How the sidebar row's keys work (proposal copy, section 4). */
export const SESSION_ROW_HINT =
  "Double-click a name to rename it. Pin keeps it on top; Remove hides it from the sidebar, the history stays on your disk.";

function formatStartedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}

export function SessionHoverContent({
  row,
  hint = false,
}: {
  readonly row: SessionListItem;
  /** Show the keys line (the sidebar, where a row can be renamed). */
  readonly hint?: boolean;
}): JSX.Element {
  const state = sessionRowState(row);
  const facts: string[] = [row.mode === "mission" ? "Mission" : "Agent"];
  if (row.permission !== "full") facts.push("Restricted");
  if (state !== null) facts.push(state.word);
  return (
    <div className="flex flex-col">
      <p className="break-words text-[14px] font-medium leading-[20px] text-ink-primary">
        {getSessionTitle(row)}
      </p>
      <p className="mt-0.5 text-[12px] leading-[18px] text-ink-tertiary">
        Started {formatStartedAt(row.startedAt)}
      </p>
      <p className="text-[12px] leading-[18px] text-ink-tertiary">
        {facts.join(" · ")}
      </p>
      {hint ? (
        <p className="mt-2.5 text-[13.5px] leading-[1.5] text-ink-secondary">
          {SESSION_ROW_HINT}
        </p>
      ) : null}
    </div>
  );
}
