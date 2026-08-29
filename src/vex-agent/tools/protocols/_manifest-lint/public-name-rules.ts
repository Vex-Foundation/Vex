/**
 * `unknown-public-name-reference` - no model-facing string may name a
 * `namespace__tool` that the catalog does not register.
 *
 * THE DEFECT THIS CLOSES. `dotted-toolid-rules.ts` proves the model is never
 * told to call a DOTTED id. It cannot prove the opposite half: that a token
 * already written in the callable `publicName` grammar names a tool that
 * EXISTS. Measured 2026-08-27, `dexscreener/handlers/screening.ts:408`: a
 * runtime refusal ended with "Call `dexscreener__narratives_trending` for the
 * ids". That tool has never existed - the real one is
 * `dexscreener__narratives_list`. The string is well-formed, callable-looking
 * and fatal: the agent has just been refused, is told exactly what to do next,
 * does it, and is refused again by the unknown-tool path with no way to
 * discover the correction.
 *
 * That string lives in a HANDLER, which the dotted rule names as explicitly out
 * of its scope ("handler-authored runtime strings ... are not reachable from
 * the catalog"). So this rule scans two surfaces, not one:
 *
 *  1. PROSE SUBJECTS - the same manifest descriptions, param descriptions and
 *     namespace navigation records the dotted rule scans, reusing its subject
 *     projections so the two rules can never disagree about what is
 *     model-visible.
 *  2. SOURCE FILES - the handler and prompt trees, CODE LINES ONLY. Comment
 *     lines are dropped before matching (a comment naming a retired tool is
 *     documentation, not an instruction the model reads), and the caller walks
 *     `.ts` sources only, so fixtures and captures are never scanned.
 *
 * ALLOWLIST, and why it holds EXACT tokens. Five model-facing strings name a
 * FAMILY of tools with a trailing `*` (`kyberswap__swap_*` on the shortcut
 * table at `engine/prompts/tool-model.ts:74`, `solana__swap_*`,
 * `solana__lend_*`). Those are deliberate: the sentence is about a pair of
 * tools, not one. They are listed by their exact spelling rather than as a
 * prefix rule, so a NEW wildcard family is a human decision instead of
 * something a `startsWith` quietly absorbs.
 */

import type { ManifestLintIssue } from "./rules.js";
import type { DottedReferenceSubject } from "./dotted-toolid-rules.js";
import type { SourceFile } from "./source-rules.js";

/**
 * A `publicName` token in prose. The grammar is `public-name-gate`'s:
 * `<namespace>__<resource_action>`, one separator, lowercase-initial segments.
 * The lookbehind keeps the rule off a longer identifier that merely contains
 * the shape, and the trailing `\*?` CAPTURES the wildcard spelling so the
 * allowlist can answer for it instead of the rule flagging `kyberswap__swap_`.
 */
const PUBLIC_NAME_TOKEN = /(?<![\w.$-])[a-z][a-z0-9]*__[a-z][A-Za-z0-9_]*\*?(?![\w])/g;

/**
 * Deliberate FAMILY spellings, exact. Each names two or more real tools in one
 * phrase; none is a tool. Adding a row is a statement that the prose means a
 * family, not an admission of debt.
 */
export const PUBLIC_NAME_WILDCARD_ALLOWLIST: readonly string[] = [
  "kyberswap__swap_*",
  "solana__swap_*",
  "solana__lend_*",
];

/**
 * A comment line, dropped before matching.
 *
 * Deliberately line-shaped rather than a parse: the surfaces this rule guards
 * are string literals on code lines, and a full-fidelity comment stripper would
 * be a second parser to own for no gain. The cost is stated rather than hidden:
 * a `publicName` written inside a trailing `// comment` on a code line is still
 * scanned, which errs toward flagging documentation rather than missing an
 * instruction the model reads.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** The code lines of a source file, comment lines blanked (line numbers kept). */
function codeLines(text: string): { readonly line: number; readonly text: string }[] {
  return text.split("\n").flatMap((line, index) =>
    isCommentLine(line) ? [] : [{ line: index + 1, text: line }]);
}

function unknownTokens(
  text: string,
  known: ReadonlySet<string>,
  allowlist: ReadonlySet<string>,
): string[] {
  PUBLIC_NAME_TOKEN.lastIndex = 0;
  const found: string[] = [];
  for (let match = PUBLIC_NAME_TOKEN.exec(text); match !== null; match = PUBLIC_NAME_TOKEN.exec(text)) {
    const token = match[0];
    if (allowlist.has(token) || known.has(token)) continue;
    if (found.includes(token)) continue;
    found.push(token);
  }
  return found;
}

/** The COMPLETE field, whitespace collapsed. Nothing is cut - same as the dotted rule. */
function normalizeField(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function message(token: string, where: string): string {
  return `model-facing text names \`${token}\`, which is not a registered tool. `
    + "A well-formed name for a tool that does not exist is worse than a dotted id: "
    + "the agent can act on it, and the unknown-tool refusal it earns carries no correction. "
    + `Name a live \`publicName\`, or drop the recommendation. ${where}`;
}

/**
 * Scan model-visible PROSE (manifest descriptions, param descriptions,
 * namespace navigation) for public names the catalog does not register.
 */
export function lintUnknownPublicNameProse(
  publicNames: readonly string[],
  subjects: readonly DottedReferenceSubject[],
): ManifestLintIssue[] {
  const known = new Set(publicNames);
  const allowed = new Set(PUBLIC_NAME_WILDCARD_ALLOWLIST);
  const issues: ManifestLintIssue[] = [];
  for (const subject of subjects) {
    for (const { field, text } of subject.fields) {
      for (const token of unknownTokens(text, known, allowed)) {
        issues.push({
          subject: subject.subject,
          rule: "unknown-public-name-reference",
          detail: `${field}/${token}`,
          message: message(token, `${field} says: ${normalizeField(text)}`),
        });
      }
    }
  }
  return issues;
}

/**
 * Scan handler and prompt SOURCE for the same defect, on code lines only.
 *
 * This is the half that catches a runtime refusal template, which is
 * model-facing but unreachable from the catalog.
 */
export function lintUnknownPublicNameSources(
  publicNames: readonly string[],
  files: readonly SourceFile[],
): ManifestLintIssue[] {
  const known = new Set(publicNames);
  const allowed = new Set(PUBLIC_NAME_WILDCARD_ALLOWLIST);
  const issues: ManifestLintIssue[] = [];
  for (const file of files) {
    for (const { line, text } of codeLines(file.text)) {
      for (const token of unknownTokens(text, known, allowed)) {
        issues.push({
          subject: file.path,
          rule: "unknown-public-name-reference",
          detail: `${line}/${token}`,
          message: message(token, `line ${line} says: ${normalizeField(text)}`),
        });
      }
    }
  }
  return issues;
}
