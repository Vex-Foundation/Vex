/**
 * Project-name to slug derivation (Vex Studio stage P).
 *
 * The slug is derived IN MAIN and is the ONLY thing that ever becomes a
 * directory name under the projects root. The renderer never supplies it, so
 * the confinement argument is entirely local to this function plus the
 * `projectSlugSchema` pattern it must satisfy:
 *
 *   - the output alphabet is `[a-z0-9-]` only, so no `/`, `\`, `:` or NUL can
 *     survive derivation;
 *   - `.` and `..` cannot survive either, because dots are not in the alphabet,
 *     so no traversal segment can be produced from any name;
 *   - a leading hyphen is stripped, so the slug can never be read as a
 *     command-line flag by a tool that later receives it;
 *   - the result is bounded at `PROJECT_SLUG_MAX_LENGTH`, matching both the
 *     schema and the DB CHECK.
 *
 * Derivation is deterministic but NOT injective: two different names can derive
 * the same slug. That is deliberate - uniqueness is decided by the `projects`
 * UNIQUE constraint and by the exclusive `mkdir` that claims the directory, not
 * by making the slug unguessable. A collision surfaces as `projects.slug_taken`.
 */

import { PROJECT_SLUG_MAX_LENGTH } from "@shared/schemas/projects.js";

/**
 * Derive a filesystem-safe slug from a project name.
 *
 * Returns `null` when the name contains nothing that survives the alphabet
 * (for example a name made entirely of punctuation or non-Latin script). The
 * caller must reject that input by name rather than inventing a fallback slug:
 * a generated placeholder would give the user a directory they did not choose.
 */
export function deriveProjectSlug(name: string): string | null {
  const lowered = name.normalize("NFKD").toLowerCase();
  const collapsed = lowered
    // Any run of characters outside the alphabet becomes a single hyphen.
    .replace(/[^a-z0-9]+/g, "-")
    // Collapse hyphen runs the previous step may have produced next to
    // existing hyphens in the name.
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (collapsed.length === 0) return null;

  // Bound to the schema/DB length. This is a derivation bound on a NEW
  // identifier, not a cut of user-visible content: the full name is stored
  // verbatim in `projects.name` and is what every surface displays.
  const bounded =
    collapsed.length > PROJECT_SLUG_MAX_LENGTH
      ? collapsed.slice(0, PROJECT_SLUG_MAX_LENGTH).replace(/-+$/, "")
      : collapsed;
  if (bounded.length === 0) return null;
  return bounded;
}
