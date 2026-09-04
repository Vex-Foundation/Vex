/**
 * `CLAUDE.md`: two import lines, and nothing else Vex owns.
 *
 * Claude Code reads `CLAUDE.md`, not `AGENTS.md`. Every other agent in the
 * registry reads `AGENTS.md`, which is where the managed block lives, so the
 * whole of Vex's interest in `CLAUDE.md` is making sure it points at the files
 * that carry the protocol: `AGENTS.md` (the authority core) and
 * `.vex/vex-guide.md` (the companion the block's first section tells every
 * other client to open for itself).
 *
 * WHY TWO IMPORTS AND NOT ONE. Claude Code resolves `@path` imports at launch,
 * up to four hops, with no byte cap - so it can hold both files, and the guide
 * costs it nothing to reach. Codex has no import mechanism at all and a 32 KiB
 * truncating budget on `AGENTS.md` (`codex-rs/core/src/agents_md.rs`), which is
 * why the split exists in the first place. Putting the guide's import inside
 * `AGENTS.md` would help Claude and be dead text for every other client, so
 * `AGENTS.md` stays a file any agent can read literally, and the import list
 * that only Claude understands stays here.
 *
 * WHY AN IMPORT AND NOT A SECOND MANAGED BLOCK. A second copy of the block
 * would be a second source of truth for text an agent acts on, and it would
 * drift the moment one of the two files was regenerated and the other was not.
 * The imports are one line each, they are idempotent, and a user who deletes
 * one gets a reported drift rather than a silently duplicated instruction set.
 *
 * NO HASH MARKER. There is no generated body to protect: the artifact IS the
 * presence of the lines. Drift for this file is therefore "a line Vex wrote is
 * gone", which `claudeMdMissingStudioImports` answers by reading the bytes -
 * and `studioClaudeMdImportSetHash` records WHICH lines Vex wrote, so a project
 * installed before the guide existed reads as stale (add the new line) rather
 * than as a user deletion (leave it alone until Repair). Everything else in the
 * file is the user's and is never rewritten, reordered or reformatted.
 */

import type { StudioRenderResult } from "./facts.js";
import { rendered } from "./facts.js";
import { studioManagedBodyHash } from "./managed-block.js";
import { STUDIO_VEX_GUIDE_PATH } from "./vex-guide.js";

/** The file Vex maintains the imports in. Repo-relative POSIX path. */
export const STUDIO_CLAUDE_MD_PATH = "CLAUDE.md";

/** The authority core. Repo-relative POSIX path. */
export const STUDIO_AGENTS_MD_PATH = "AGENTS.md";

/** The exact line Vex writes for the block. Claude Code's `@path` import syntax. */
export const STUDIO_CLAUDE_MD_IMPORT = `@${STUDIO_AGENTS_MD_PATH}`;

/** The exact line Vex writes for the guide. */
export const STUDIO_VEX_GUIDE_IMPORT = `@${STUDIO_VEX_GUIDE_PATH}`;

/**
 * Every import Vex maintains, in the order a fresh file lists them.
 *
 * ORDER MATTERS to a reader, not to Claude Code: the authority comes first and
 * the companion follows it, which is the order the two files' own text assumes.
 */
export const STUDIO_CLAUDE_MD_IMPORTS: readonly string[] = [
  STUDIO_CLAUDE_MD_IMPORT,
  STUDIO_VEX_GUIDE_IMPORT,
];

/**
 * Which of Vex's imports this file does NOT have, in list order.
 *
 * Line-exact on a trimmed line, deliberately. A mention of `@AGENTS.md` inside a
 * sentence or a fenced code block is prose, not an import, and treating it as
 * one would make Vex report a working project as configured when it is not.
 */
export function claudeMdMissingStudioImports(existing: string): readonly string[] {
  const lines = new Set(existing.split("\n").map((line) => line.trim()));
  return STUDIO_CLAUDE_MD_IMPORTS.filter((line) => !lines.has(line));
}

/**
 * The digest of the import set Vex wrote, recorded as this artifact's entry
 * hash.
 *
 * It is what tells a later run whether a missing line is one Vex ever put
 * there. A provenance row with no hash at all predates the guide - Vex wrote
 * only the `AGENTS.md` import then - and the reconciler reads it exactly that
 * way.
 */
export function studioClaudeMdImportSetHash(
  imports: readonly string[] = STUDIO_CLAUDE_MD_IMPORTS,
): string {
  return studioManagedBodyHash(imports.join("\n"));
}

/**
 * Of Vex's imports that are NOT in this file, the ones provenance proves Vex
 * WROTE here: the deletions, as opposed to the lines Vex has only started
 * writing since.
 *
 * ONE OWNER for a rule two callers need. The reconciler asks it to decide
 * between "put the line back" and "leave the user's deletion alone until
 * Repair"; the project-file badge asks it to decide between `drifted` and
 * `stale`. Two copies would eventually disagree, and the disagreement would
 * show up as a badge promising a render that then refuses.
 *
 * `recordedEntryHash` is the artifact's provenance entry hash: `undefined` when
 * the store has no row for this file at all (Vex never wrote here), `null` when
 * the row predates the guide import (Vex wrote only `@AGENTS.md` then), and
 * otherwise the digest of the set Vex wrote.
 */
export function studioClaudeMdDeletedImports(
  existing: string,
  recordedEntryHash: string | null | undefined,
): readonly string[] {
  if (recordedEntryHash === undefined) return [];
  const written = recordedEntryHash === studioClaudeMdImportSetHash()
    ? STUDIO_CLAUDE_MD_IMPORTS
    : [STUDIO_CLAUDE_MD_IMPORT];
  return claudeMdMissingStudioImports(existing).filter((line) => written.includes(line));
}

/** The contents of `CLAUDE.md` when Vex creates it from nothing. */
export function renderFreshClaudeMd(): StudioRenderResult {
  return rendered(
    [
      "# Project instructions",
      "",
      "The shared instructions for every coding agent in this project live in",
      "`AGENTS.md`, and the rest of the Vex protocol - what changed in Vex, the",
      "protocols available here, what an app built on them inherits and how a Vex",
      "bug is reported - lives in `.vex/vex-guide.md`. These lines import both.",
      "",
      ...STUDIO_CLAUDE_MD_IMPORTS,
      "",
    ].join("\n"),
  );
}

/**
 * An EXISTING `CLAUDE.md` with the missing imports appended.
 *
 * Append, never insert at the top: the user's first heading and any front
 * matter stay where they are. One blank line separates the imports from
 * whatever came before them, a file that already has both lines is `unchanged`,
 * and a file that has one of them gains only the other - without moving the
 * line it already had.
 */
export function mergeClaudeMdImports(existing: string): StudioRenderResult {
  const missing = claudeMdMissingStudioImports(existing);
  if (missing.length === 0) return { status: "unchanged" };

  const separator = existing === ""
    ? ""
    : existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n") ? "\n" : "\n\n";
  return rendered(`${existing}${separator}${missing.join("\n")}\n`);
}

/**
 * `CLAUDE.md` with Vex's import lines removed and every other byte preserved.
 *
 * Removes the blank separator line the append inserted, for the same reason and
 * with the same nuance as the managed block: whitespace at a seam, never
 * content. A5 NEVER deletes the file itself, whatever is left in it.
 */
export function removeClaudeMdImports(existing: string): StudioRenderResult {
  if (claudeMdMissingStudioImports(existing).length === STUDIO_CLAUDE_MD_IMPORTS.length) {
    return { status: "unchanged" };
  }

  const ours = new Set<string>(STUDIO_CLAUDE_MD_IMPORTS);
  const kept: string[] = [];
  for (const line of existing.split("\n")) {
    if (ours.has(line.trim())) {
      // Reclaim the one blank line the append put in front of the imports. The
      // second import sits directly under the first, so only the blank line
      // above the pair is ever reclaimed.
      if (kept.length >= 2 && kept[kept.length - 1] === "") kept.pop();
      continue;
    }
    kept.push(line);
  }
  return rendered(kept.join("\n"));
}
