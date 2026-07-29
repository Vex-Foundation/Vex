/**
 * SESSION — the session's metadata at a glance: mode, access, mission status,
 * started. Card grammar (`PortfolioCard`, C3) since the book became one card
 * stack. Built on existing IPC (`sessions.get`) + the pure sessionListModel
 * helpers. Wallet holdings live in the Position card, not here.
 */

import type { JSX, ReactNode } from "react";
import { useSession } from "../../../lib/api/sessions.js";
import { cn } from "../../../lib/utils.js";
import { formatSessionTime, getMissionActivity } from "../sessionListModel.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";

/** Key/value row: muted label, stronger tabular value, hairline-separated. */
function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--vex-line)] py-1.5 last:border-b-0 last:pb-0.5">
      <span className="text-[10.5px] text-[var(--vex-text-3)]">{label}</span>
      <span className="min-w-0 truncate text-right text-[11.5px] tabular-nums text-[var(--vex-text)]">
        {children}
      </span>
    </div>
  );
}

export function SessionBlock({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element {
  const query = useSession(sessionId);
  const session = query.data?.ok ? query.data.data : null;

  if (session === null) {
    return (
      <PortfolioCard eyebrow="Session">
        {query.isLoading ? (
          <CardStateNote tone="loading">Loading…</CardStateNote>
        ) : (
          <CardStateNote>Unavailable.</CardStateNote>
        )}
      </PortfolioCard>
    );
  }

  const activity = getMissionActivity(session);
  return (
    <PortfolioCard eyebrow="Session">
      <div className="flex flex-col">
        <Row label="Mode">{session.mode === "mission" ? "Mission" : "Agent"}</Row>
        <Row label="Access">
          {session.permission === "full" ? "Full" : "Restricted"}
        </Row>
        {activity !== null ? (
          <Row label="Status">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn("h-1.5 w-1.5 rounded-full", activity.dotClass)}
              />
              {activity.label}
            </span>
          </Row>
        ) : null}
        <Row label="Started">{formatSessionTime(session.startedAt)}</Row>
      </div>
    </PortfolioCard>
  );
}
