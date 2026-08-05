/**
 * The two SOURCE-level convention rules. Pure: the caller reads the files (the
 * test walks the tree, same as `signer-import-allowlist.test.ts`) and hands
 * them here as text.
 *
 *  - `generic-error-literal` — the mechanical half of the 2026-08-02 decree
 *    that a failed tool call states what actually happened. A message the agent
 *    cannot act on ("unexpected error") makes it retry blind and spends the
 *    user's money.
 *  - `slippage-default-home` — exactly one module may decide what a call with
 *    no slippage means. Nine copies of the number, six of them inside prequote
 *    hash material, is a quote that stops authorizing its own execute.
 */

import type { ManifestLintIssue } from "./rules.js";

export interface SourceFile {
  /** Repo-relative path — the allowlist subject, so it must be stable. */
  readonly path: string;
  readonly text: string;
}

/**
 * Literals that tell the agent nothing. Each is matched as agent-facing prose,
 * so the pattern is deliberately anchored to the phrase rather than the word
 * "failed", which legitimately appears in specific messages.
 */
const GENERIC_ERROR_LITERALS: readonly string[] = [
  "unexpected error",
  "something went wrong",
  "an error occurred",
  "unknown error occurred",
];

/** `const FOO_DEFAULT_SLIPPAGE_BPS = 50` in any spelling. */
const SLIPPAGE_DEFAULT_DECLARATION = /\b[A-Za-z0-9_]*DEFAULT_SLIPPAGE_BPS\b\s*(?::[^=]+)?=/;

/** `params.slippageBps ?? 50` — an inline default is still a default. */
const INLINE_SLIPPAGE_DEFAULT = /slippage[A-Za-z]*["'`)\]\s]*\?\?\s*\d+/i;

/** The one module allowed to own the default (repo-relative). */
export const SLIPPAGE_DEFAULT_OWNER = "src/vex-agent/tools/protocols/slippage-policy.ts";

/**
 * The linter's own sources quote the patterns they forbid. Scanning them would
 * record the rule's definition as a violation of itself, so the caller filters
 * them out before scanning.
 */
export function isLinterOwnSource(path: string): boolean {
  return path.includes("/protocols/_manifest-lint");
}

export function lintGenericErrorLiterals(files: readonly SourceFile[]): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [];
  for (const file of files) {
    const lowered = file.text.toLowerCase();
    for (const literal of GENERIC_ERROR_LITERALS) {
      if (!lowered.includes(literal)) continue;
      issues.push({
        subject: file.path,
        rule: "generic-error-literal",
        detail: literal,
        message:
          `source contains the generic agent-facing literal "${literal}" — surface the real, sanitized `
          + "cause instead (a generic label on a diagnosable failure makes the agent retry blind).",
      });
    }
  }
  return issues;
}

export function lintSlippageDefaultHome(files: readonly SourceFile[]): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [];
  for (const file of files) {
    if (file.path === SLIPPAGE_DEFAULT_OWNER) continue;
    for (const [index, line] of file.text.split("\n").entries()) {
      const declares = SLIPPAGE_DEFAULT_DECLARATION.test(line);
      const inline = INLINE_SLIPPAGE_DEFAULT.test(line);
      if (!declares && !inline) continue;
      issues.push({
        subject: file.path,
        rule: "slippage-default-home",
        // The offending SOURCE TEXT, not a line number: an allowlist key that
        // moves every time an unrelated line is added is not a debt record.
        detail: line.replace(/\s+/g, " ").trim(),
        message:
          `line ${index + 1} declares its own slippage default — import VEX_DEFAULT_SLIPPAGE_BPS from `
          + `${SLIPPAGE_DEFAULT_OWNER} instead; a second copy splits the prequote match hash.`,
      });
    }
  }
  return issues;
}
