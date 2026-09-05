/**
 * PROJECT - the project-scoped counterpart of the SESSION card (owner parity
 * decree, 2026-09-04): what the Studio rail is instrumenting, at a glance.
 *
 * Rows, in the SESSION card's grammar and vocabulary: Mode (always "Studio",
 * the way a session says "Agent" or "Mission"), Access from the project's
 * own `permission` (the SAME `sessionPermissionSchema` words the session card
 * renders), Started from `createdAt` (same date format), and Path from
 * `displayPath` - the one row a project has and a session does not, kept
 * because a Studio user reads paths. `displayPath` is TEXT FOR A LABEL and
 * grants nothing (`projectDtoSchema`).
 *
 * Reads the project through the same detail query the Wallets card uses. It
 * does NOT read the project's `backingSessionId`: rendering another entity's
 * session state under a project's name is an owner decision, not a card's.
 */

import type { JSX } from "react";
import { useProject } from "../../../lib/api/projects.js";
import { formatSessionTime } from "../sessionListModel.js";
import {
  CardKeyValueRow as Row,
  CardStateNote,
  PortfolioCard,
} from "./portfolio/PortfolioCard.js";

export function ProjectBlock({
  projectId,
}: {
  readonly projectId: string;
}): JSX.Element {
  const query = useProject(projectId);
  const project =
    query.data !== undefined && query.data.ok ? query.data.data : null;

  if (project === null) {
    return (
      <PortfolioCard eyebrow="Project">
        {query.isLoading ? (
          <CardStateNote tone="loading">Loading…</CardStateNote>
        ) : (
          <CardStateNote>Unavailable.</CardStateNote>
        )}
      </PortfolioCard>
    );
  }

  return (
    <PortfolioCard eyebrow="Project">
      <div className="flex flex-col">
        <Row label="Mode">Studio</Row>
        <Row label="Access">
          {project.permission === "full" ? "Full" : "Restricted"}
        </Row>
        <Row label="Started">{formatSessionTime(project.createdAt)}</Row>
        {/* A path is a technical artifact, so it is set in mono like an
          * address; the full value rides on the row's title for the truncated
          * case and the e2e reads it whole from the DOM. */}
        <Row label="Path" title={project.displayPath}>
          <span className="font-mono text-[11px]">{project.displayPath}</span>
        </Row>
      </div>
    </PortfolioCard>
  );
}
