/**
 * One decision on the Needs you page (docs/design/R3-MINIMAL.md section 8.5):
 * the group head of where it was raised (a session, a Studio project, or a
 * background approval) with its Open key, then the approval itself, either as
 * the FULL `ApprovalCard` or folded to its row.
 *
 * The card is the same component the session mounts, so the REAL FUNDS stamp,
 * Reject's first focus, the two-step confirm for a high-risk action and the
 * click lock are the inline card's own: a destructive action can never be
 * one-click approved here. It is mounted with `idVariant="global"` so its
 * `approval-card-<id>-` title id stays unique when the SAME approval also
 * renders inline in the session under the page (duplicate DOM ids break
 * `aria-labelledby`).
 *
 * PROVENANCE (B4c): a Studio-raised approval is grouped under its project, and
 * the project name in the head carries the id in its title and accessible
 * name; the joined name rides into the card so its project field shows a name
 * rather than a bare uuid. A row with no project draws its session instead:
 * an empty tag would be a fact the row does not have.
 */

import type { JSX } from "react";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { ApprovalCard } from "../ApprovalCard.js";
import {
  approvalProjectDetail,
  approvalProjectDisplay,
} from "../approvals/approvals-copy.js";
import { formatNeedsYouTime } from "../../vex/needs-you.js";

/**
 * The page's two navigations, each ONE write set in one click handler (React
 * batches them into a single commit):
 *   - open a session: the agent mode first, then the selection, then the page
 *     closed, so the jump lands on the transcript even from Studio;
 *   - open a project: the Studio mode, the project, then the page closed.
 * Neither is an authority change: the approval is still decided in its own
 * card under the same two-step confirm.
 */
export function useNeedsYouNavigation(): {
  readonly openSession: (sessionId: string) => void;
  readonly openProject: (projectId: string) => void;
} {
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);
  return {
    openSession: (sessionId) => {
      setRuntimeMode("agent");
      setActiveSessionId(sessionId);
      setShellRoute({ kind: "none" });
    },
    openProject: (projectId) => {
      setRuntimeMode("studio");
      setActiveProjectId(projectId);
      setShellRoute({ kind: "none" });
    },
  };
}

export interface NeedsYouGroupHeadProps {
  /** Where the decisions were raised, by name. */
  readonly where: string;
  /** The Studio project, when the group is one: its name carries the id. */
  readonly projectId: string | null;
  readonly projectName: string | null;
  /** The muted words after the name ("· Vex Studio project"). */
  readonly context: string | null;
  /** The head's key at the right ("Open session", "Open project"). */
  readonly open: { readonly label: string; readonly onOpen: () => void } | null;
}

/** A group head: the name in ink, its context in muted type, the Open key. */
export function NeedsYouGroupHead({
  where,
  projectId,
  projectName,
  context,
  open,
}: NeedsYouGroupHeadProps): JSX.Element {
  return (
    <div className="vex-needs-page__group-head" data-vex-area="needs-you-group-head">
      {projectId !== null ? (
        <span
          data-vex-area="approval-project-tag"
          title={approvalProjectDetail(projectId, projectName)}
          aria-label={approvalProjectDetail(projectId, projectName)}
          className="vex-needs-page__group-name"
        >
          {approvalProjectDisplay(projectId, projectName)}
        </span>
      ) : (
        <span className="vex-needs-page__group-name">{where}</span>
      )}
      {context !== null ? <span>{context}</span> : null}
      <span className="vex-needs-page__sp" />
      {open !== null ? (
        <button type="button" className="vex-needs-page__open" onClick={open.onOpen}>
          {open.label}
        </button>
      ) : null}
    </div>
  );
}

/** The head's muted context for an approval's group. */
function approvalGroupContext(row: ApprovalPendingGlobalDto): string | null {
  if (row.projectId !== null) return "· Vex Studio project";
  const asked = formatNeedsYouTime(row.createdAt, Date.now());
  return asked === null ? null : `· asked ${asked}`;
}

export interface GlobalApprovalItemProps {
  readonly row: ApprovalPendingGlobalDto;
  /** Called after an Open key navigated to the owning session or project. */
  readonly onOpenSession: () => void;
  /** Draw the group head above the decision (the first one of its group). */
  readonly head?: boolean;
  /** The full card (default), or the folded row. */
  readonly expanded?: boolean;
  /** The folded row's Review key: open this decision as the full card. */
  readonly onReview?: () => void;
  /** The full card takes the first focus, on Reject, when it mounts. */
  readonly focusOnMount?: boolean;
}

export function GlobalApprovalItem({
  row,
  onOpenSession,
  head = true,
  expanded = true,
  onReview,
  focusOnMount = false,
}: GlobalApprovalItemProps): JSX.Element {
  const { openSession, openProject } = useNeedsYouNavigation();
  const sessionLabel =
    row.sessionTitle ?? (row.sessionId !== null ? "Untitled session" : "Background approval");

  // The upstream read nulls `sessionId` for session-less and deleted-session
  // rows, so "Open session" gates on it directly; a Studio approval with no
  // session opens its project instead.
  const { sessionId, projectId } = row;
  const open =
    sessionId !== null
      ? {
          label: "Open session",
          onOpen: () => {
            openSession(sessionId);
            onOpenSession();
          },
        }
      : projectId !== null
        ? {
            label: "Open project",
            onOpen: () => {
              openProject(projectId);
              onOpenSession();
            },
          }
        : null;

  return (
    <div data-vex-area="global-approval-item">
      {head ? (
        <NeedsYouGroupHead
          where={sessionLabel}
          projectId={projectId}
          projectName={row.projectName}
          context={approvalGroupContext(row)}
          open={open}
        />
      ) : null}
      <ApprovalCard
        summary={row}
        sessionId={sessionId ?? ""}
        focusOnMount={focusOnMount}
        idVariant="global"
        projectName={row.projectName}
        layout={expanded ? "card" : "row"}
        onReview={onReview}
      />
    </div>
  );
}
