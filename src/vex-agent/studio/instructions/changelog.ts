/**
 * THE VERSIONED NOTES the managed block opens with: what moved in Vex since the
 * reader last looked, in the reader's own terms.
 *
 * WHY A CHECKED-IN LIST AND NOT THE PROJECT'S OWN CHANGE LOG. The project change
 * log (`StudioChangeNote`, written by the installer into the durable provenance
 * store) records what happened to THIS PROJECT: a wallet was reselected, an
 * agent config was added. It cannot say what changed about VEX, because the
 * installer that writes it has no record of a tool that was added or a rule that
 * was reworded. This list is that second axis, authored with the change itself
 * and shipped with the build, Next.js style: an entry lands in the same commit
 * as the behaviour it describes, so the file a project reads after an update
 * says what the update did.
 *
 * THE TAGS COME FROM THE SAME LIST, NEVER FROM A HAND-WRITTEN STRING. Every
 * section and every protocol block asks `studioChangelogTag(subject)` for its
 * "Added in Vex x.y" / "Changed in Vex x.y" label, so a tag cannot outlive the
 * entry that justified it and an entry cannot fail to mark what it changed.
 *
 * PURE DATA. Nothing here reads a database, the app version or the environment:
 * the version each entry carries is written into the entry when it is authored,
 * which is what keeps the goldens byte-stable while the shipped file still says
 * which release moved what.
 */

/** What an entry did. */
export type StudioChangelogKind = "added" | "changed" | "removed";

/** What kind of thing it did it to. */
export type StudioChangelogTarget = "protocol" | "tool" | "rule";

/**
 * One authored note.
 *
 * `subject` is the TAG KEY as well as the display name: the section or protocol
 * block whose heading carries the version tag looks itself up by this exact
 * string, so a renderer and an entry cannot disagree about what was changed.
 */
export interface StudioChangelogEntry {
  /** The Vex version that shipped it, e.g. `0.2.7`. */
  readonly version: string;
  readonly kind: StudioChangelogKind;
  readonly target: StudioChangelogTarget;
  /** The tool name, protocol namespace, rule name or section key it touched. */
  readonly subject: string;
  /** One line, already written for a reader who is not a Vex developer. */
  readonly text: string;
}

/**
 * How many VERSIONS of notes the section shows.
 *
 * A bound on versions rather than on entries, so one busy release cannot push
 * every other release out of view. Older versions are dropped from the SECTION;
 * this list is the full record and nothing is hidden anywhere else.
 */
export const STUDIO_CHANGELOG_VERSION_LIMIT = 8;

/**
 * Every authored note, NEWEST FIRST.
 *
 * Add an entry in the same change as the behaviour it describes. Never edit an
 * entry that has shipped: a project that already read it would silently disagree
 * with a project that reads it now.
 */
export const STUDIO_CHANGELOG: readonly StudioChangelogEntry[] = [
  {
    version: "0.2.7",
    kind: "added",
    target: "tool",
    subject: "vex_ToolDescribe",
    text:
      "vex_ToolDescribe returns one tool's whole contract - full description, "
      + "input schema, risk class, whether it raises the approval card, the Vex "
      + "fee and what it returns - so a description your client truncated is "
      + "one call away rather than lost.",
  },
  {
    version: "0.2.7",
    kind: "changed",
    target: "tool",
    subject: "BridgeExecute",
    text:
      "BridgeExecute is unchanged except for one parameter: the `recipient` "
      + "override is gone. The destination is derived from the source wallet, "
      + "which is what the description already claimed; the parameter that "
      + "contradicted it was removed.",
  },
  {
    version: "0.2.7",
    kind: "removed",
    target: "tool",
    subject: "WebResearch",
    text:
      "WebResearch is no longer on the Vex MCP surface - your client has its own "
      + "web search, so Vex stopped shipping a second one that needed a provider "
      + "key of its own. Use your client's web search and fetch for anything "
      + "off-chain; every on-chain and market tool is unchanged.",
  },
  {
    version: "0.2.7",
    kind: "changed",
    target: "rule",
    subject: "How to work with Vex MCP",
    text:
      "The APPROVAL rule now says what actually happens over MCP: a destructive "
      + "call BLOCKS until the user answers the card in Vex and the result you "
      + "receive is the settled outcome. The approval itself never returns a "
      + "pending status to poll, so calling again while one is unanswered is "
      + "always wrong; the operation it approved can still settle later, and a "
      + "`pending` bridge or Solana swap is resolved by reading, never by "
      + "calling again.",
  },
  {
    version: "0.2.7",
    kind: "added",
    target: "rule",
    subject: "This project",
    text:
      "The permission level in force is now stated in full, and each level says "
      + "what NOT to do: this project renders the paragraph for its own level "
      + "only, so the full-access wording (a destructive call executes directly "
      + "with no approval card) appears only in a full-access project.",
  },
  {
    version: "0.2.7",
    kind: "added",
    target: "rule",
    subject: "Protocols available to this project",
    text:
      "Every protocol this server exposes now has its own block here - chains, "
      + "read tools, executing tools, the quote/execute pair and whether its "
      + "required key is configured in this installation.",
  },
  {
    version: "0.2.7",
    kind: "added",
    target: "rule",
    subject: "How to do the common jobs",
    text:
      "The task shapes Vex itself follows - balances, swap, bridge, send, wrap, "
      + "an arbitrary transaction, research - are written out with their tool "
      + "sequence, quote freshness and refusal points.",
  },
];

/** The versions that have at least one entry, newest first, bounded. */
export function studioChangelogVersions(
  entries: readonly StudioChangelogEntry[] = STUDIO_CHANGELOG,
): readonly string[] {
  return [...new Set(entries.map((entry) => entry.version))]
    .slice(0, STUDIO_CHANGELOG_VERSION_LIMIT);
}

/** The entries of the versions the section shows, in list order. */
export function studioChangelogWindow(
  entries: readonly StudioChangelogEntry[] = STUDIO_CHANGELOG,
): readonly StudioChangelogEntry[] {
  const shown = new Set(studioChangelogVersions(entries));
  return entries.filter((entry) => shown.has(entry.version));
}

/**
 * The version tag for one section or protocol block, or `null`.
 *
 * The NEWEST entry naming that subject wins, so a block changed twice carries
 * the later label. "removed" does not tag a heading: the thing it names is gone,
 * and there is nothing left to put a label beside.
 */
export function studioChangelogTag(
  subject: string,
  entries: readonly StudioChangelogEntry[] = STUDIO_CHANGELOG,
): string | null {
  const entry = entries.find(
    (candidate) => candidate.subject === subject && candidate.kind !== "removed",
  );
  if (entry === undefined) return null;
  return `${entry.kind === "added" ? "Added" : "Changed"} in Vex ${entry.version}`;
}

/** A heading with its version tag appended, or the heading unchanged. */
export function studioTaggedHeading(heading: string, subject: string): string {
  const tag = studioChangelogTag(subject);
  return tag === null ? heading : `${heading} (${tag})`;
}

/**
 * The counts the installer's own change-log line names on a re-render:
 * "Vex 0.2.7: 2 added, 1 changed".
 *
 * Returns `null` when the version shipped no notes, so the installer says
 * nothing rather than "0 added, 0 changed".
 */
export function studioChangelogSummary(
  version: string,
  entries: readonly StudioChangelogEntry[] = STUDIO_CHANGELOG,
): string | null {
  const forVersion = entries.filter((entry) => entry.version === version);
  if (forVersion.length === 0) return null;
  const parts: string[] = [];
  for (const kind of ["added", "changed", "removed"] as const) {
    const count = forVersion.filter((entry) => entry.kind === kind).length;
    if (count > 0) parts.push(`${String(count)} ${kind}`);
  }
  return `Vex ${version}: ${parts.join(", ")}`;
}
