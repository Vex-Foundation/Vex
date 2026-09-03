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
 *
 * `othersAwaiting` is the count of the OTHER cross-mode approvals observed in
 * the same tick. There is one transient slot, so a toast per row would
 * overwrite itself and the user would see only the last; but the batch-mates
 * are all marked announced and never get a line of their own, so a bare
 * single-row sentence would be an undercount of what is waiting. The named
 * approval stays the subject and the rest are counted, which is a bound that
 * REPORTS what it left out rather than a cut that hides it.
 */
export function crossModeApprovalToast(input: {
  readonly originatedInStudio: boolean;
  readonly tool: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly othersAwaiting: number;
}): string {
  const where = input.originatedInStudio
    ? input.projectId === null
      ? "Vex Studio"
      : approvalProjectDisplay(input.projectId, input.projectName)
    : "the agent shell";
  const line = `Approval waiting in ${where}: ${input.tool}`;
  if (input.othersAwaiting <= 0) return line;
  return `${line}, and ${String(input.othersAwaiting)} more awaiting`;
}

/** The eyebrow above the actor line in the approval card's details. */
export const APPROVAL_ACTOR_FIELD_LABEL = "Requested by";

/** The eyebrow above the approval's own identifier. */
export const APPROVAL_PROPOSAL_FIELD_LABEL = "Proposal";

/** The eyebrow above the moment this approval stops being decidable. */
export const APPROVAL_EXPIRY_FIELD_LABEL = "Expires";

/** What the card says when no MCP client name was recorded. */
export const APPROVAL_UNNAMED_MCP_CLIENT = "an MCP client";

/**
 * WHO proposed this action, as one sentence for the card's actor row.
 *
 * Rule 90 binds an approval to its actor AND to whether an agent proposed it,
 * and the two are one fact for a reader: "Claude Code (an MCP client) in
 * project vex-studio" answers both at once. The three inputs are the three
 * things Vex actually knows, and none of them is derived from model input:
 *
 *   - `origin` is the durable provenance column (`agent` / `studio_mcp`), the
 *     only one of the three that is authority-relevant;
 *   - `requestedByClient` is the client's self-declared `initialize` name,
 *     sanitized and bounded at both boundaries it crosses. An absent name is
 *     the honest {@link APPROVAL_UNNAMED_MCP_CLIENT}, NEVER a blank row;
 *   - the project display is where the client is working.
 *
 * `null` means there is no actor row to render: an approval with no recorded
 * provenance must not be captioned "Vex's agent", because a Studio-originated
 * row wearing that caption is a lie about authority (see
 * `normaliseIntentOrigin`).
 *
 * NOT "Terminal N". The terminal a client runs in is not knowable here: a
 * Studio MCP connection binds a `projectId` in its handshake line and nothing
 * else, and one project's endpoint serves every terminal in it. The project is
 * the finest true answer, so it is the one given.
 */
export function approvalActorLine(input: {
  readonly origin: "agent" | "studio_mcp" | null;
  readonly requestedByClient: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
}): string | null {
  if (input.origin === null) return null;
  if (input.origin === "agent") return "Vex's own agent";
  const trimmed = input.requestedByClient?.trim() ?? "";
  const who =
    trimmed.length > 0
      ? `${trimmed} (an MCP client)`
      : APPROVAL_UNNAMED_MCP_CLIENT;
  if (input.projectId === null) return who;
  return `${who} in ${approvalProjectDisplay(input.projectId, input.projectName)}`;
}
