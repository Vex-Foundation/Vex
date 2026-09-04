/**
 * The three SOURCE-level convention rules. Pure: the caller reads the files (the
 * test walks the tree, same as `signer-import-allowlist.test.ts`) and hands
 * them here as text.
 *
 *  - `generic-error-literal` - the mechanical half of the 2026-08-02 decree
 *    that a failed tool call states what actually happened. A message the agent
 *    cannot act on ("unexpected error") makes it retry blind and spends the
 *    user's money.
 *  - `slippage-default-home` - exactly one module may decide what a call with
 *    no slippage means. Nine copies of the number, six of them inside prequote
 *    hash material, is a quote that stops authorizing its own execute.
 *  - `stale-output-cap-claim` - no string may assert a global tool-output byte
 *    cap, because the runtime enforces none.
 */

import type { ManifestLintIssue } from "./rules.js";

export interface SourceFile {
  /** Repo-relative path - the allowlist subject, so it must be stable. */
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

/** `params.slippageBps ?? 50` - an inline default is still a default. */
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
          `source contains the generic agent-facing literal "${literal}" - surface the real, sanitized `
          + "cause instead (a generic label on a diagnosable failure makes the agent retry blind).",
      });
    }
  }
  return issues;
}

/**
 * The phantom output cap.
 *
 * The runtime once externalised any tool result over `TOOL_OUTPUT_OVERFLOW_BYTES`
 * (16,384). That module, `engine/core/tool-output-policy.ts`, was DELETED, and
 * `engine/core/turn-loop-tool-batch/results.ts` now persists every tool output
 * verbatim and inline. Nothing in the tool path measures output bytes at all.
 *
 * The strings did not follow. Prompts, tool descriptions, param descriptions and
 * one runtime error kept telling the model to budget against 16,384 bytes, which
 * is the worst kind of stale copy: it is specific, quantitative, and false, so
 * the model spends real calls narrowing a window nothing was going to cut.
 *
 * WHAT THIS FORBIDS, AND WHAT IT DOES NOT. Two ways to fire, because the claim
 * has two spellings and the first draft of this rule caught only one:
 *
 *   1. An UNAMBIGUOUS global-cap phrase, magnitude or not. The retired-parameter
 *      error said "1.6-1.9x the tool-output cap" and named no number at all - a
 *      magnitude-gated rule would have let the single worst string through,
 *      since a ratio to a nonexistent cap is less falsifiable, not more.
 *   2. A 16 KB-shaped magnitude AND weaker cap-shaped prose ("response limit",
 *      "context budget") on the SAME line.
 *
 * A measured byte figure on its own is exactly what a good description carries
 * ("a bare recent call measured 27,970 B") and stays legal; so does an unrelated
 * 16384 (scrypt `N`, `maxOutputTokens`, `REASONING_PAYLOAD_CAP`). What is never
 * legal again is telling the model a global ceiling exists.
 *
 * THE FIX, when this fires: keep the measured number, delete the cap clause, and
 * name the real producer-level bound instead - the tool's own `limit`, `offset`,
 * `fetchTop`, `count`/`cursor`, or its projection. Every model-facing site
 * corrected in Batch 3 Wave 0 had one. If a surface genuinely has no bound, say
 * that; do not invent a ceiling to replace the one that was removed.
 *
 * NO ALLOWLIST ENTRIES. Unlike the debt tables, this rule lands at zero and the
 * suite asserts that no allowlist row for it exists, so a future occurrence
 * cannot be admitted by recording it as debt.
 */
/** 16,384 / 16_384 / 16384 / 16 KB / 16KiB - the removed cap's magnitude. */
const OUTPUT_CAP_MAGNITUDE = /\b16[,_]?384\b|\b16\s?Ki?B\b/i;

/**
 * Names the removed global mechanism outright. Fires ALONE, because the claim
 * does the damage whether or not it quotes the number.
 *
 * `output cap` is listed without a `tool-` prefix on purpose: a bare "the output
 * cap" in a tool-path file means this cap and nothing else. A rule that reads
 * only the hyphenated spelling is one paraphrase away from useless. Comments
 * about a genuinely different bound must name that bound (`MAX_REFS`), which is
 * better writing anyway.
 */
const GLOBAL_CAP_PHRASE =
  /\btool[- ]?output\s+(?:byte\s+)?(?:cap|ceiling|limit)\b|\boutput\s+(?:byte\s+)?cap\b|\boverflow\s+(?:cap|threshold)\b/i;

/**
 * Weaker cap-shaped prose: ordinary words that only mean the phantom cap when a
 * 16 KB magnitude sits on the same line.
 */
const WEAK_CAP_PROSE =
  /\btruncat|\boverflow\b|\b(?:output|response|result|context|payload)\s+(?:byte\s+)?(?:cap|ceiling|limit|budget|threshold)\b|\b(?:cap|ceiling|limit|budget|threshold)\s+on\s+(?:tool\s+)?(?:output|response|result)\b/i;

export function lintStaleOutputCapClaims(files: readonly SourceFile[]): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [];
  for (const file of files) {
    for (const line of file.text.split("\n")) {
      const asserted = GLOBAL_CAP_PHRASE.test(line)
        || (OUTPUT_CAP_MAGNITUDE.test(line) && WEAK_CAP_PROSE.test(line));
      if (!asserted) continue;
      issues.push({
        subject: file.path,
        rule: "stale-output-cap-claim",
        // The offending SOURCE TEXT, not a line number - same reason as
        // `slippage-default-home`.
        detail: line.replace(/\s+/g, " ").trim(),
        message:
          "asserts a global tool-output byte cap. The runtime enforces none: "
          + "`engine/core/tool-output-policy.ts` was deleted and tool output is persisted "
          + "verbatim and inline. Keep the measured byte figure, drop the cap clause, and name "
          + "the real producer-level bound instead (`limit`, `offset`, `fetchTop`, `count`, or "
          + "the projection). Do not invent a ceiling to replace the removed one.",
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
          `line ${index + 1} declares its own slippage default - import VEX_DEFAULT_SLIPPAGE_BPS from `
          + `${SLIPPAGE_DEFAULT_OWNER} instead; a second copy splits the prequote match hash.`,
      });
    }
  }
  return issues;
}
