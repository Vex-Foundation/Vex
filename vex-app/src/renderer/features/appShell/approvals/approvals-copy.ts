/**
 * Copy for the approvals provenance surfaces (B4c). Resolved here so the row,
 * the card and the toast cannot drift into three different words for one fact.
 *
 * Nothing here is a security decision: `projectName` is user-authored free
 * text bounded to 80 chars by the column's own CHECK and is DISPLAY ONLY -
 * `projectId` is the identity anything binds on, and it travels beside the
 * name in the title/aria detail so a renamed or tombstoned project is still
 * identifiable.
 */

/** The eyebrow above the provenance value in the approval card's details. */
export const APPROVAL_PROJECT_FIELD_LABEL = "Project";

/**
 * What the row's tag and the card's field SAY. The name when the read carried
 * one; the id itself otherwise (the inline session card reads
 * `ApprovalSummaryDto`, which has no joined name), so the field is never a
 * placeholder and never empty.
 */
export function approvalProjectDisplay(
  projectId: string,
  projectName: string | null,
): string {
  const trimmed = projectName?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : projectId;
}

/**
 * The full provenance, for the `title` attribute and the accessible name. The
 * id is always present here even when the name is what is shown, because the
 * name is not identity.
 */
export function approvalProjectDetail(
  projectId: string,
  projectName: string | null,
): string {
  const trimmed = projectName?.trim() ?? "";
  return trimmed.length > 0
    ? `Vex Studio project ${trimmed} (${projectId})`
    : `Vex Studio project ${projectId}`;
}

/**
 * The cross-mode toast line: an approval was raised in the mode the user is
 * NOT looking at.
 *
 * It NAMES the tool and the project so the sentence is actionable on its own -
 * the toast is not clickable, so it has to carry its own answer to "which
 * one". `tool` arrives already resolved by the caller ("(unknown tool)" is the
 * established fallback), and nothing here is derived from an approval's
 * arguments.
 */
export function crossModeApprovalToast(input: {
  readonly originatedInStudio: boolean;
  readonly tool: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
}): string {
  if (!input.originatedInStudio) {
    return `Approval waiting in the agent shell: ${input.tool}`;
  }
  const where =
    input.projectId === null
      ? "Vex Studio"
      : approvalProjectDisplay(input.projectId, input.projectName);
  return `Approval waiting in ${where}: ${input.tool}`;
}
