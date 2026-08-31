/**
 * One row of the DESK RULE global approvals inbox.
 *
 * A session header (title → "Untitled session" → "Background approval" for a
 * session-less / deleted-session row) with an optional "Open session" jump,
 * then the FULL `ApprovalCard` reused verbatim so the two-step high-risk
 * confirm + risk/action stamps + critical-args well are identical to the
 * inline card — a destructive action can never be one-click approved here.
 *
 * The card is mounted with `idVariant="global"` so its `approval-card-<id>-`
 * title element id stays unique when the SAME approval also renders inline in
 * the active session (A3 — duplicate DOM ids break `aria-labelledby`).
 *
 * PROVENANCE (B4c): a Studio-raised approval wears a small project tag beside
 * the session header, and the joined project NAME rides into the card so its
 * details field can show a name rather than a bare uuid. The tag renders only
 * when the row actually carries a project - an agent approval has none, and an
 * empty tag would be a fact the row does not have. The name deliberately
 * survives a tombstone upstream, so the tag can outlive the project it names;
 * the id in its title is what stays identifiable.
 */

import type { JSX } from "react";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { ApprovalCard } from "../ApprovalCard.js";
import {
  approvalProjectDetail,
  approvalProjectDisplay,
} from "../approvals/approvals-copy.js";

export interface GlobalApprovalItemProps {
  readonly row: ApprovalPendingGlobalDto;
  /** Close the panel after navigating to the owning session. */
  readonly onOpenSession: () => void;
}

export function GlobalApprovalItem({
  row,
  onOpenSession,
}: GlobalApprovalItemProps): JSX.Element {
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const setShellRoute = useUiStore((s) => s.setShellRoute);

  // A5 nulls `sessionId` for session-less / deleted-session rows upstream, so
  // "Open session" gates on it directly.
  const canOpenSession = row.sessionId !== null;
  const sessionLabel =
    row.sessionTitle ?? (row.sessionId !== null ? "Untitled session" : "Background approval");

  const openSession = (): void => {
    if (row.sessionId === null) return;
    setActiveSessionId(row.sessionId);
    // A full-app screen (Memory / Missions / …) may be covering the shell —
    // close it so the jump actually lands on the session transcript.
    setShellRoute({ kind: "none" });
    onOpenSession();
  };

  return (
    <div
      data-vex-area="global-approval-item"
      className="border-b border-[var(--vex-line)] px-3 py-2 last:border-b-0"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
            {sessionLabel}
          </span>
          {row.projectId !== null ? (
            <span
              data-vex-area="approval-project-tag"
              title={approvalProjectDetail(row.projectId, row.projectName)}
              aria-label={approvalProjectDetail(row.projectId, row.projectName)}
              className="min-w-0 shrink truncate rounded-[3px] border border-[var(--vex-line-strong)] px-1 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-2)]"
            >
              {approvalProjectDisplay(row.projectId, row.projectName)}
            </span>
          ) : null}
        </span>
        {canOpenSession ? (
          <button
            type="button"
            onClick={openSession}
            className="shrink-0 rounded-[3px] font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-2)] hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            Open session
          </button>
        ) : null}
      </div>
      <ApprovalCard
        summary={row}
        sessionId={row.sessionId ?? ""}
        focusOnMount={false}
        idVariant="global"
        projectName={row.projectName}
      />
    </div>
  );
}
