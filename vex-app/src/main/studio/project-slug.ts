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
 *     schema and the DB CHECK;
 *   - a bounded result that spells a Windows reserved device name (`con`,
 *     `aux`, `com1`, ...) is REFUSED on every platform, because a project
 *     folder created on Linux must still be openable on Windows.
 *
 * Derivation is deterministic but NOT injective: two different names can derive
 * the same slug. That is deliberate - uniqueness is decided by the `projects`
 * UNIQUE constraint and by the exclusive `mkdir` that claims the directory, not
 * by making the slug unguessable. A collision surfaces as `projects.slug_taken`.
 */

import { PROJECT_SLUG_MAX_LENGTH } from "@shared/schemas/projects.js";

/**
 * Why a name produced no slug. Two DIFFERENT situations with two different
 * things for the user to do, so they are two members rather than one `null`.
 */
export type ProjectSlugRefusal = "no_usable_characters" | "reserved_device_name";

export type ProjectSlugDerivation =
  | { readonly kind: "slug"; readonly slug: string }
  | { readonly kind: "refused"; readonly reason: ProjectSlugRefusal };

/**
 * The MS-DOS device names the Win32 path namespace still reserves.
 *
 * Windows resolves these in EVERY directory: `mkdir con` fails, and a folder
 * named `aux` cannot be created, opened, or deleted through an ordinary Win32
 * path. Microsoft's own filesystem-naming documentation lists CON, PRN, AUX,
 * NUL, COM0-COM9 and LPT0-LPT9, and states they are reserved both bare and
 * followed by an extension (`NUL.txt` is the device, not a file).
 *
 * WHAT THIS IMPLEMENTS, AND WHAT IT CANNOT: only the BARE forms are checked,
 * because only the bare forms are reachable. A dot cannot survive the slug
 * alphabet, so `nul.txt` derives `nul-txt`, which is an ordinary name. The
 * dot-suffixed form is therefore documented here rather than coded: adding a
 * pattern for input this function cannot produce would be a guard against a
 * shape that does not exist.
 *
 * ALSO NOT CHECKED, deliberately: `CLOCK$`, `CONIN$` and `CONOUT$`. `$` is not
 * in the alphabet either, so they derive `clock`, `conin` and `conout`, and
 * those three are NOT reserved names. Refusing them would refuse a legitimate
 * project called "Clock".
 *
 * COM0 and LPT0 are included even though the classic list starts at 1: current
 * Microsoft documentation names them, and the reference implementation
 * (VS Code's `isValidBasename`) matches `com[0-9]` / `lpt[0-9]`. A refused name
 * costs the user one rename; a folder that cannot be opened on Windows costs
 * them the project.
 *
 * THE CHECK RUNS ON EVERY PLATFORM, and that is the whole point: a project
 * created on Linux lives in a folder the user may later open on Windows (a
 * synced home directory, a restored backup, a dual-boot workspace, the same
 * repository cloned on a second machine). A per-platform guard would produce
 * projects that exist on one operating system and cannot be opened on another.
 */
const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 10 }, (_unused, index) => `com${String(index)}`),
  ...Array.from({ length: 10 }, (_unused, index) => `lpt${String(index)}`),
]);

/**
 * Derive a filesystem-safe slug from a project name.
 *
 * Refuses with `no_usable_characters` when the name contains nothing that
 * survives the alphabet (a name made entirely of punctuation, or of non-Latin
 * script), and with `reserved_device_name` when what survives is a Windows
 * device name. The caller must reject the input by name rather than inventing a
 * fallback slug: a generated placeholder would give the user a directory they
 * did not choose.
 */
export function deriveProjectSlug(name: string): ProjectSlugDerivation {
  const lowered = name.normalize("NFKD").toLowerCase();
  const collapsed = lowered
    // Any run of characters outside the alphabet becomes a single hyphen.
    .replace(/[^a-z0-9]+/g, "-")
    // Collapse hyphen runs the previous step may have produced next to
    // existing hyphens in the name.
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (collapsed.length === 0) return { kind: "refused", reason: "no_usable_characters" };

  // Bound to the schema/DB length. This is a derivation bound on a NEW
  // identifier, not a cut of user-visible content: the full name is stored
  // verbatim in `projects.name` and is what every surface displays.
  const bounded =
    collapsed.length > PROJECT_SLUG_MAX_LENGTH
      ? collapsed.slice(0, PROJECT_SLUG_MAX_LENGTH).replace(/-+$/, "")
      : collapsed;
  if (bounded.length === 0) return { kind: "refused", reason: "no_usable_characters" };

  // AFTER the bound, not before: bounding is what can turn a long name into a
  // short one, and the short one is what becomes the directory.
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(bounded)) {
    return { kind: "refused", reason: "reserved_device_name" };
  }
  return { kind: "slug", slug: bounded };
}
