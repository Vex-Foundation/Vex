/**
 * Presentational header + body for `ApprovalCard` (F3).
 *
 * Renders the approval title (`namespace:tool`), the risk + action stamps, the
 * reasoning preview, the critical-args well, and the inline error alert. Pure
 * presentation: it holds no state, owns no decision logic, and emits no events
 * — the two-step confirm gate and mutation wiring stay in `ApprovalCard`.
 * Testids, aria, and TEXT CONTENT are pinned by tests and stay verbatim; the
 * chrome speaks the landing's amber alert register (.ws-alert): mono-uppercase
 * title in --vex-pin over the card's pin fill.
 */

import type { JSX } from "react";
import type {
  ApprovalPreview,
  ApprovalSummaryDto,
} from "@shared/schemas/approvals.js";
import { riskChipClasses } from "./risk.js";
import {
  APPROVAL_ACTOR_FIELD_LABEL,
  APPROVAL_EXPIRY_FIELD_LABEL,
  APPROVAL_PROJECT_FIELD_LABEL,
  APPROVAL_PROPOSAL_FIELD_LABEL,
  approvalActorLine,
  approvalProjectDetail,
  approvalProjectDisplay,
} from "../approvals/approvals-copy.js";

/**
 * Human labels for the engine-injected, non-argument preview keys. A tool
 * ARGUMENT is shown under its own name on purpose (the user is verifying the
 * exact field that will be signed), but `vexFee` is not an argument — it is
 * Vex's own cost disclosure, and "VEXFEE" is not what a person calls it.
 * Tolerant reader: a key with no entry keeps its raw name, and an absent key
 * renders no row at all — never a placeholder or a zero.
 */
const CRITICAL_ARG_LABELS: Readonly<Record<string, string>> = { vexFee: "Vex fee" };

export interface ApprovalDetailsProps {
  readonly summary: ApprovalSummaryDto;
  readonly titleId: string;
  readonly namespace: string | null;
  readonly toolName: string;
  /** `preview.criticalArgs` (JSON-safe scalars) or null — same shape the parent reads. */
  readonly criticalArgs: ApprovalPreview["criticalArgs"] | null;
  readonly inlineError: string | null;
  /**
   * The joined Vex Studio project NAME, when the caller's read carried one
   * (`ApprovalPendingGlobalDto`). The inline session card reads
   * `ApprovalSummaryDto`, which has no join, and passes nothing - the field
   * then shows `summary.projectId`, which is the identity anyway. Display
   * only: user-authored text, never anything this card binds on.
   */
  readonly projectName?: string | null;
  /**
   * S5 — one-shot signed glint in the stamp area after a successful approve.
   * The ONLY light in the approvals flow; reject never sets it.
   */
  readonly signedGlint?: boolean;
}

export function ApprovalDetails({
  summary,
  titleId,
  namespace,
  toolName,
  criticalArgs,
  inlineError,
  projectName = null,
  signedGlint = false,
}: ApprovalDetailsProps): JSX.Element {
  const actorLine = approvalActorLine({
    origin: summary.origin,
    requestedByClient: summary.requestedByClient,
    projectId: summary.projectId,
    projectName,
  });
  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--vex-line)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3
            id={titleId}
            className="truncate font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--vex-pin)]"
          >
            Approval needed:{" "}
            <span className="font-mono">
              {namespace !== null ? `${namespace}:${toolName}` : toolName}
            </span>
          </h3>
        </div>
        {/* Stamp grammar — text content stays verbatim (tests pin it). */}
        {summary.riskLevel !== null ? (
          <span
            data-testid="risk-chip"
            className={`shrink-0 rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${riskChipClasses(
              summary.riskLevel,
            )}`}
          >
            {summary.riskLevel}
          </span>
        ) : null}
        {summary.actionKind !== null ? (
          <span
            data-testid="action-chip"
            className="shrink-0 rounded-[3px] border border-[var(--vex-line-strong)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-2)]"
          >
            {summary.actionKind}
          </span>
        ) : null}
        {/* The signed glint — plays once via stylesheet keyframes and ends
            transparent; unmounting early is fine (grace note, not contract). */}
        {signedGlint ? (
          <span
            aria-hidden
            data-vex-signed-glint=""
            className="vex-intro-glint h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--vex-accent-text)]"
          />
        ) : null}
      </header>
      <div className="space-y-3 px-4 py-3">
        {/* THE BOUND FACTS (rule 90: an approval binds at least the actor and
            whether an agent proposed it, the resource, the expiry and the
            proposal identity). They are ROW-LEVEL facts of the durable intent,
            not `criticalArgs`: the card's `preview_json` is what the Studio
            authority digest covers and what the pre-dispatch revalidation
            rebuilds from the tool call alone, so a field the rebuild cannot
            reproduce would make every Studio dispatch refuse on card mismatch.
            Rendering them here puts them in front of the human without
            touching what the digest binds.

            Each row renders only when the approval CARRIES that fact - an
            agent-mode approval has no project, a legacy row has no expiry, and
            an empty "Project: -" would invent one. */}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          {actorLine !== null ? (
            <div data-testid="approval-actor" className="contents">
              <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                {APPROVAL_ACTOR_FIELD_LABEL}
              </dt>
              <dd className="break-all text-[var(--vex-text-2)]">{actorLine}</dd>
            </div>
          ) : null}
          {/* PROVENANCE (B0/B4c). The NAME is what the user reads; the ID rides
              in the title and the accessible name, because a name can be
              edited or belong to a tombstoned project and the id cannot. */}
          {summary.projectId !== null ? (
            <div data-testid="approval-project" className="contents">
              <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                {APPROVAL_PROJECT_FIELD_LABEL}
              </dt>
              <dd
                className="break-all text-[var(--vex-text-2)]"
                title={approvalProjectDetail(summary.projectId, projectName)}
                aria-label={approvalProjectDetail(summary.projectId, projectName)}
              >
                {approvalProjectDisplay(summary.projectId, projectName)}
              </dd>
            </div>
          ) : null}
          <div data-testid="approval-proposal" className="contents">
            <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
              {APPROVAL_PROPOSAL_FIELD_LABEL}
            </dt>
            <dd className="break-all text-[var(--vex-text-2)]">{summary.id}</dd>
          </div>
          {/* The instant this approval stops being decidable, carried WHOLE and
              in UTC exactly as the durable row states it. Not localized and not
              rendered as "in 9 minutes": a countdown computed in the renderer
              is a second source of truth for the one deadline the engine's
              sweep and the broker's timer already own. */}
          {summary.expiresAt !== null ? (
            <div data-testid="approval-expiry" className="contents">
              <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                {APPROVAL_EXPIRY_FIELD_LABEL}
              </dt>
              <dd className="break-all text-[var(--vex-text-2)]">
                {summary.expiresAt}
              </dd>
            </div>
          ) : null}
        </dl>
        {summary.reasoningPreview.trim().length > 0 ? (
          <p className="italic text-[var(--vex-text-2)]">
            {summary.reasoningPreview}
          </p>
        ) : null}
        {/* Critical args — recessed well: the facts being signed for. */}
        {criticalArgs !== null && Object.keys(criticalArgs).length > 0 ? (
          <dl
            data-testid="critical-args"
            className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-[6px] border border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-3 py-2 font-mono text-[11px]"
          >
            {Object.entries(criticalArgs).map(([k, v]) => (
              // `display: contents` keeps the grid layout while giving each
              // pair a stable React key.
              <div key={k} className="contents">
                <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                  {CRITICAL_ARG_LABELS[k] ?? k}
                </dt>
                <dd className="break-all text-[var(--vex-text-2)]">{String(v)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {inlineError !== null ? (
          <p
            role="alert"
            className="rounded-[6px] border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {inlineError}
          </p>
        ) : null}
      </div>
    </>
  );
}
