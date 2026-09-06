/**
 * SESSION - the session's metadata at a glance: mode, access, mission status,
 * started. Card grammar (`PortfolioCard`, C3) since the book became one card
 * stack. Built on existing IPC (`sessions.get`) + the pure sessionListModel
 * helpers. Wallet holdings live in the Position card, not here. Its
 * project-scoped counterpart is `ProjectBlock`, on the same row primitive.
 */

import type { JSX } from "react";
import { useSession } from "../../../lib/api/sessions.js";
import { formatSessionTime, getMissionActivity } from "../sessionListModel.js";
import {
  StateDot,
  type StateDotState,
} from "../../../components/ui/state-dot.js";
import {
  CardKeyValueRow as Row,
  CardStateNote,
  PortfolioCard,
} from "./portfolio/PortfolioCard.js";

/** Mission-activity tone to StateDot state (word + dot, never color alone). */
const ACTIVITY_DOT: Record<"active" | "paused" | "stopped", StateDotState> = {
  active: "ongoing",
  paused: "warning",
  stopped: "done",
};

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
              {/* Status grammar: the word carries the meaning, the StateDot
                * carries the motion (ongoing = pixel chase). */}
              <StateDot state={ACTIVITY_DOT[activity.tone]} size={8} />
              {activity.label}
            </span>
          </Row>
        ) : null}
        <Row label="Started">{formatSessionTime(session.startedAt)}</Row>
      </div>
    </PortfolioCard>
  );
}
