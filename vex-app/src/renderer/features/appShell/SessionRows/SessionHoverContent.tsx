/**
 * Hover-card body for a session row: the FULL title (the row truncates),
 * absolute started time, mode word, and the state facts that deviate from
 * the default (restricted permission, live/paused mission). Renders on the
 * HoverCard primitive's dark plate, so the inks are the fixed on-chrome
 * ladder, not theme labels.
 */

import type { JSX } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { getMissionActivity, getSessionTitle } from "../sessionListModel.js";

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
}: {
  readonly row: SessionListItem;
}): JSX.Element {
  const activity = getMissionActivity(row);
  const facts: string[] = [row.mode === "mission" ? "Mission" : "Agent"];
  if (row.permission !== "full") facts.push("Restricted");
  if (activity?.tone === "active") facts.push("Live");
  if (activity?.tone === "paused") facts.push("Paused");
  return (
    <div className="flex flex-col gap-2">
      <p className="break-words text-[14px] leading-[20px] text-ink-on-chrome">
        {getSessionTitle(row)}
      </p>
      <p className="text-[12px] leading-[16px] text-[color-mix(in_oklab,var(--vex-alias-label-on-chrome)_80%,transparent)]">
        Started {formatStartedAt(row.startedAt)}
      </p>
      <p className="text-[12px] leading-[16px] text-[color-mix(in_oklab,var(--vex-alias-label-on-chrome)_65%,transparent)]">
        {facts.join(" · ")}
      </p>
    </div>
  );
}
