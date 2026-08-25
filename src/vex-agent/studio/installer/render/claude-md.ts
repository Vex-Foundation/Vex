/**
 * `CLAUDE.md`: one import line, and nothing else Vex owns.
 *
 * Claude Code reads `CLAUDE.md`, not `AGENTS.md`. Every other agent in the
 * registry reads `AGENTS.md`, which is where the managed block lives, so the
 * whole of Vex's interest in `CLAUDE.md` is making sure it points at that file.
 *
 * WHY AN IMPORT AND NOT A SECOND MANAGED BLOCK. A second copy of the block
 * would be a second source of truth for text an agent acts on, and it would
 * drift the moment one of the two files was regenerated and the other was not.
 * The import is one line, it is idempotent, and a user who deletes it gets a
 * reported drift rather than a silently duplicated instruction set.
 *
 * NO HASH MARKER. There is no generated body to protect: the artifact IS the
 * presence of the line. Drift for this file is therefore "the line is gone",
 * which `claudeMdImportsAgents` answers by reading the bytes. Everything else in
 * the file is the user's and is never rewritten, reordered or reformatted.
 */

import type { StudioRenderResult } from "./facts.js";
import { rendered } from "./facts.js";

/** The file Vex maintains the import in. Repo-relative POSIX path. */
export const STUDIO_CLAUDE_MD_PATH = "CLAUDE.md";

/** The file being imported. Repo-relative POSIX path. */
export const STUDIO_AGENTS_MD_PATH = "AGENTS.md";

/** The exact line Vex writes. Claude Code's `@path` import syntax. */
export const STUDIO_CLAUDE_MD_IMPORT = `@${STUDIO_AGENTS_MD_PATH}`;

/**
 * Does this file already import `AGENTS.md`?
 *
 * Line-exact on a trimmed line, deliberately. A mention of `@AGENTS.md` inside a
 * sentence or a fenced code block is prose, not an import, and treating it as
 * one would make Vex report a working project as configured when it is not.
 */
export function claudeMdImportsAgents(existing: string): boolean {
  return existing
    .split("\n")
    .some((line) => line.trim() === STUDIO_CLAUDE_MD_IMPORT);
}

/** The contents of `CLAUDE.md` when Vex creates it from nothing. */
export function renderFreshClaudeMd(): StudioRenderResult {
  return rendered(
    [
      "# Project instructions",
      "",
      "The shared instructions for every coding agent in this project, including",
      "the Vex Studio section, live in `AGENTS.md`. This line imports them.",
      "",
      STUDIO_CLAUDE_MD_IMPORT,
      "",
    ].join("\n"),
  );
}

/**
 * An EXISTING `CLAUDE.md` with the import appended.
 *
 * Append, never insert at the top: the user's first heading and any front
 * matter stay where they are. One blank line separates the import from whatever
 * came before it, and a file that already has the line is `unchanged`.
 */
export function mergeClaudeMdImport(existing: string): StudioRenderResult {
  if (claudeMdImportsAgents(existing)) return { status: "unchanged" };

  const separator = existing === ""
    ? ""
    : existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n") ? "\n" : "\n\n";
  return rendered(`${existing}${separator}${STUDIO_CLAUDE_MD_IMPORT}\n`);
}

/**
 * `CLAUDE.md` with the import line removed and every other byte preserved.
 *
 * Removes the blank separator line the append inserted, for the same reason and
 * with the same nuance as the managed block: whitespace at a seam, never
 * content. A5 NEVER deletes the file itself, whatever is left in it.
 */
export function removeClaudeMdImport(existing: string): StudioRenderResult {
  if (!claudeMdImportsAgents(existing)) return { status: "unchanged" };

  const lines = existing.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (line.trim() === STUDIO_CLAUDE_MD_IMPORT) {
      // Reclaim the one blank line the append put in front of the import.
      if (kept.length >= 2 && kept[kept.length - 1] === "") kept.pop();
      continue;
    }
    kept.push(line);
  }
  return rendered(kept.join("\n"));
}
