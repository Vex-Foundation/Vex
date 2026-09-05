/**
 * THE ENVIRONMENT A VEX TERMINAL RUNS IN.
 *
 * Two separate obligations live here, and conflating them is how shells end up
 * inheriting an IDE's private state:
 *
 *  1. The BASE. Captured ONCE at host boot from `process.env`, with a
 *     deny-list applied. Captured once because `process.env` is mutable and a
 *     terminal spawned an hour into the session must not inherit whatever some
 *     later code path happened to set.
 *  2. The OVERLAY. Per-terminal, supplied by main. `null` DELETES a variable,
 *     an absent key leaves the base alone, and a string sets it. Three
 *     outcomes, because "delete" and "do not touch" are genuinely different
 *     instructions and a two-valued API cannot express both.
 *
 * The deny-list shape is VS Code's `sanitizeProcessEnvironment`: patterns to
 * remove, plus an explicit preserve list that wins over them.
 */

import type { IProcessEnvironment } from "./types.js";

/**
 * Variables removed from the base before any shell sees it.
 *
 *  - `ELECTRON_*` describes the runtime that happens to host Vex. A shell that
 *    inherits `ELECTRON_RUN_AS_NODE` will silently turn any `electron` the user
 *    runs into a bare Node process, which is a genuinely confusing bug to chase.
 *  - `VEX_*` is this application's own configuration, including the pty host's
 *    boot keys (`config.ts` deletes those separately - see its note on why both
 *    locks exist).
 *  - `SNAP*` and `GDK_PIXBUF_*` are Linux packaging leakage: a Snap-confined
 *    Vex exports loader paths that break unrelated binaries launched from its
 *    terminal. VS Code strips exactly these for exactly this reason.
 *
 * WHAT VEX'S OWN INTEGRATION NEEDS COMES BACK THROUGH THE OVERLAY, not through
 * an exception here. `VEX_CONFIG_DIR` is the live case: main sets it per
 * terminal from the directory it RESOLVED
 * (`main/studio/terminals.ts: studioTerminalEnvironmentOverlay`), which is the
 * split VS Code makes between `sanitizeProcessEnvironment` and the workbench's
 * `createTerminalEnvironment`. Preserving the launcher's value instead would
 * export whatever the launcher happened to set, including nothing.
 *
 * `CLAUDE_CODE_*` IS DELIBERATELY NOT DENIED (rejected 2026-09-03). Vex
 * launched from inside a Claude Code session passes that session's markers -
 * `CLAUDE_CODE_CHILD_SESSION` among them - into every terminal, and Claude
 * Code inside one then reports its transcript saving off. Stripping them would
 * be Vex deleting a THIRD PARTY'S configuration out of a user's shell, and a
 * user who exported those variables on purpose would find them missing with no
 * signal. The deny-list removes what THIS process set, which is the rule VS
 * Code follows and the only one that stays correct as other tools' variables
 * appear.
 */
const DENIED_PATTERNS: readonly RegExp[] = [
  /^ELECTRON_.+$/,
  /^VEX_.+$/,
  /^SNAP(|_.*)$/,
  /^GDK_PIXBUF_.+$/,
];

/**
 * Names the deny-list must NOT remove.
 *
 * Empty, and deliberately so: no `ELECTRON_*`, `VEX_*`, `SNAP*` or
 * `GDK_PIXBUF_*` variable is something a user's shell benefits from. It exists
 * as a named, testable constant rather than an implicit absence so that adding
 * an exception is a visible decision with a place to write down its reason.
 *
 * IT STAYED EMPTY when `VEX_CONFIG_DIR` had to reach Studio terminals. A
 * preserve entry would have carried the LAUNCHER's value - absent on every
 * install that never sets one - while the overlay carries the value the app
 * actually resolved. Preserve answers "keep what we inherited"; the question
 * was "assert what we resolved", and those are different questions.
 */
export const TERMINAL_ENV_PRESERVE: readonly string[] = [];

/**
 * Values Vex ASSERTS about its terminals, applied under the overlay.
 *
 * `TERM` and `COLORTERM` are capability claims the renderer's xterm actually
 * honours, so a wrong value here shows up as broken colour rather than as a
 * cosmetic difference. `TERM_PROGRAM` lets a user's own dotfiles detect Vex.
 * `LANG` is set ONLY when missing, because overriding a user's chosen locale
 * would change how their own tools format numbers and dates.
 */
const ASSERTED: ReadonlyArray<readonly [string, string]> = [
  ["TERM", "xterm-256color"],
  ["COLORTERM", "truecolor"],
  ["TERM_PROGRAM", "vex-studio"],
];

const ASSERTED_WHEN_MISSING: ReadonlyArray<readonly [string, string]> = [
  ["LANG", "en_US.UTF-8"],
];

/** Apply the deny-list to a copy. The input is never mutated. */
export function scrubEnvironment(
  source: NodeJS.ProcessEnv,
  preserve: readonly string[] = TERMINAL_ENV_PRESERVE,
): IProcessEnvironment {
  const kept = new Set(preserve);
  const out: IProcessEnvironment = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!kept.has(key) && DENIED_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Compose the environment for one terminal.
 *
 * Order is base -> overlay -> asserted -> asserted-when-missing. The assertions
 * come AFTER the overlay because they are Vex's claims about the terminal it is
 * rendering, not preferences: an overlay that set `TERM=dumb` would produce a
 * shell whose escape sequences the renderer cannot interpret.
 */
export function buildTerminalEnvironment(
  base: IProcessEnvironment,
  overlay: Readonly<Record<string, string | null>>,
): IProcessEnvironment {
  const out: IProcessEnvironment = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = value;
  }
  for (const [key, value] of ASSERTED) out[key] = value;
  for (const [key, value] of ASSERTED_WHEN_MISSING) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/**
 * The ONLY form of an environment that may reach a log.
 *
 * A terminal's environment routinely carries `GITHUB_TOKEN`, `AWS_*`,
 * `npm_config__auth` and whatever else the user exported before launching Vex.
 * Logging it would put credentials in a file users attach to bug reports, so
 * the values are replaced with their length and nothing else: enough to
 * diagnose "the variable was empty" without carrying what it contained.
 *
 * VS Code applies the same transform on its `node-pty.IPty#spawn` trace, which
 * is the trace this host's own spawn log mirrors.
 */
export function sanitizeEnvForLogging(
  env: IProcessEnvironment | undefined,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    out[key] = `<${String((env[key] ?? "").length)} chars>`;
  }
  return out;
}
