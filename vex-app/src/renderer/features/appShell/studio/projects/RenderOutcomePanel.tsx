/**
 * WHAT VEX DID TO EACH FILE, rendered from one reconciliation run.
 *
 * ONE component for the creator, the settings editor and the repair dialog,
 * because all three receive the same `StudioRenderOutcome` and the user is
 * owed the same answer from all three. Three copies of this would be three
 * chances for one of them to quietly drop the row that refused.
 *
 * ## Nothing here is summarised away
 *
 * Every artifact in the envelope gets a row, including `unchanged`. A panel
 * that showed only what changed would make "Vex touched nothing" and "Vex was
 * refused on all four files" look identical, and those are opposite facts. The
 * refusal reason, the drift detail, the unsupported reason and its return
 * condition are printed in full: they are already sanitized by main (rule 07)
 * and they are the only part the user can act on.
 *
 * ## `superseded` is a real answer
 *
 * A run that rendered nothing because a newer scope version was already queued
 * says exactly that, rather than showing an empty list that reads like success.
 * `completed: false` gets its own notice for the same reason: the durable
 * marker did not advance, so the project is still owed a reconciliation and the
 * user is the one who has to ask for it.
 */

import type { JSX } from "react";
import type {
  StudioArtifactOutcome,
  StudioRenderOutcome,
} from "@shared/schemas/studio-installer.js";
import { IconWarning } from "../../../../components/icons/index.js";
import { Pill } from "../../../../components/ui/pill.js";
import { agentPresentation } from "./studio-agent-catalogue.js";
import {
  ARTIFACT_KIND_LABELS,
  ARTIFACT_STATUS_LABELS,
  DRIFT_BLOCKED_SENTENCE,
  INSTALLER_WARNING_SENTENCES,
  PROJECT_OUTCOME_LIST_LABEL,
  PROJECT_WARNING_LIST_LABEL,
  REFUSAL_REASON_SENTENCES,
  RENDER_INCOMPLETE_NOTICE,
  RENDER_OUTCOME_EMPTY,
  RENDER_OUTCOME_TITLE,
  RENDER_TRIGGER_SENTENCES,
  RENDER_WARNINGS_TITLE,
  agentSupportReturnsSentence,
  artifactChangeLabel,
} from "./projects-copy.js";

export interface RenderOutcomePanelProps {
  readonly render: StudioRenderOutcome;
}

/**
 * Which register a row reads in. Only two, deliberately: a row either reports
 * something Vex DID, or something Vex DECLINED to do. Colouring `written`
 * differently from `unchanged` would make the noisiest rows the loudest.
 */
function isDeclined(outcome: StudioArtifactOutcome): boolean {
  return (
    outcome.status === "refused" ||
    outcome.status === "drift_blocked" ||
    outcome.status === "unsupported"
  );
}

export function RenderOutcomePanel({
  render,
}: RenderOutcomePanelProps): JSX.Element {
  return (
    <section
      className="flex flex-col gap-3"
      data-vex-render-outcome={render.trigger}
    >
      <div className="flex flex-col gap-1">
        <h3 className="vex-eyebrow">{RENDER_OUTCOME_TITLE}</h3>
        <p className="text-xs text-ink-tertiary">
          {RENDER_TRIGGER_SENTENCES[render.trigger]}
        </p>
        {!render.completed ? (
          <p
            role="status"
            className="flex items-start gap-1.5 text-xs text-warning"
          >
            <IconWarning size={13} className="mt-0.5 shrink-0" />
            <span>{RENDER_INCOMPLETE_NOTICE}</span>
          </p>
        ) : null}
      </div>

      {render.artifacts.length === 0 ? (
        <p className="text-xs text-ink-tertiary">{RENDER_OUTCOME_EMPTY}</p>
      ) : (
        <ArtifactOutcomeList artifacts={render.artifacts} />
      )}

      {render.warnings.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h4 className="vex-eyebrow">{RENDER_WARNINGS_TITLE}</h4>
          <ul
            aria-label={PROJECT_WARNING_LIST_LABEL}
            className="flex flex-col gap-1.5"
          >
            {render.warnings.map((warning, index) => (
              <li
                key={`${warning.kind}:${warning.agentId ?? "-"}:${String(index)}`}
                className="flex items-start gap-1.5 text-xs text-warning"
                data-vex-warning-kind={warning.kind}
              >
                <IconWarning size={13} className="mt-0.5 shrink-0" />
                <span className="flex flex-col gap-0.5">
                  <span>{INSTALLER_WARNING_SENTENCES[warning.kind]}</span>
                  <span className="text-ink-tertiary">{warning.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The per-artifact rows on their own, so the DELETE dialog can render the
 * cleanup report with them.
 *
 * A delete's `cleanup` is an array of the SAME `StudioArtifactOutcome`s a
 * render run produces - the schema builds both from `artifactOutcomeSchema` -
 * but it has no scope version, no trigger and no `completed` flag, so it is not
 * a `StudioRenderOutcome` and must not be dressed up as one. Exporting the list
 * is what lets both surfaces show the same rows without either inventing the
 * fields the other has.
 */
export function ArtifactOutcomeList({
  artifacts,
}: {
  readonly artifacts: readonly StudioArtifactOutcome[];
}): JSX.Element {
  return (
    <ul
      aria-label={PROJECT_OUTCOME_LIST_LABEL}
      className="flex flex-col gap-1.5"
      data-vex-outcome-rows={String(artifacts.length)}
    >
      {artifacts.map((artifact, index) => (
        <ArtifactRow
          // Composite key: one run can legitimately carry two rows with the
          // same kind and the same agent (a config plus its additional write),
          // so the index is part of the identity rather than a fallback. The
          // list is never reordered, so this is stable.
          key={`${artifact.kind}:${artifact.agentId ?? "-"}:${String(index)}`}
          artifact={artifact}
        />
      ))}
    </ul>
  );
}

function ArtifactRow({
  artifact,
}: {
  readonly artifact: StudioArtifactOutcome;
}): JSX.Element {
  const declined = isDeclined(artifact);
  const agentName =
    artifact.agentId === null
      ? null
      : agentPresentation(artifact.agentId).displayName;

  return (
    <li
      className="flex flex-col gap-1 rounded-lg border border-line-2 px-3 py-2"
      data-vex-artifact-status={artifact.status}
      data-vex-artifact-kind={artifact.kind}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-ink-primary">
            {agentName === null
              ? ARTIFACT_KIND_LABELS[artifact.kind]
              : `${ARTIFACT_KIND_LABELS[artifact.kind]} - ${agentName}`}
          </span>
          {/* Repo-relative text for a label, never a capability. An
            * `unsupported` row has no file at all, so it prints no path
            * rather than an empty one. */}
          {artifact.path !== null ? (
            <span className="truncate font-mono text-[10px] text-ink-tertiary">
              {artifact.path}
            </span>
          ) : null}
        </span>
        <Pill size="sm" variant={declined ? "caution" : "neutral"}>
          {artifact.status === "written"
            ? artifactChangeLabel(artifact.change)
            : ARTIFACT_STATUS_LABELS[artifact.status]}
        </Pill>
      </div>

      {artifact.status === "refused" ? (
        <span className="flex flex-col gap-0.5 text-xs text-warning">
          <span>{REFUSAL_REASON_SENTENCES[artifact.reason]}</span>
          <span className="text-ink-tertiary">{artifact.detail}</span>
        </span>
      ) : null}

      {artifact.status === "drift_blocked" ? (
        <span className="flex flex-col gap-0.5 text-xs text-warning">
          <span>{DRIFT_BLOCKED_SENTENCE}</span>
          <span className="text-ink-tertiary">{artifact.detail}</span>
        </span>
      ) : null}

      {artifact.status === "unsupported" ? (
        <span className="flex flex-col gap-0.5 text-xs text-ink-tertiary">
          <span>{artifact.reason}</span>
          <span>{agentSupportReturnsSentence(artifact.supportReturnsWhen)}</span>
        </span>
      ) : null}
    </li>
  );
}
