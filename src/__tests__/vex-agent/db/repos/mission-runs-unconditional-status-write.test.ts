/**
 * REGRESSION GUARD for the terminal-stop invariant — SCOPED TO ONE CLASS OF
 * WRITE: callers of the repo's unconditional `missionRunsRepo.updateStatus`.
 *
 * The invariant it serves: a terminal user Stop (`status = 'stopped'`,
 * `stop_reason = 'user_stopped'`) must never be overwritten or reopened by any
 * other write to `mission_runs.status`.
 *
 * WHAT THIS SCAN DOES NOT COVER (say it plainly rather than let the file read
 * as exhaustive): it greps for `updateStatus(` call sites only. A raw
 * `UPDATE mission_runs SET status = …` written inline anywhere in `src/`, or a
 * status write reached through another repo function, is invisible to it. Those
 * paths are guarded by review and by the targeted tests on each writer, not by
 * this file. Do not read a green run here as "no unguarded status write exists".
 *
 * Three review rounds each found "you guarded the writes you knew about, here
 * are more of the same class". Guarding instances one at a time loses, because
 * nothing stops the NEXT unguarded caller from being added. This test closes
 * that one class: it enumerates every call site of the unconditional
 * `missionRunsRepo.updateStatus` in `src/` and fails when one appears outside
 * the allowlist documented on the function itself.
 *
 * A lint-style enumeration was chosen over a runtime test because the risk is
 * a NEW call site, not a behaviour of the existing ones — and over an ESLint
 * rule because the repo's verification entry point is vitest and a bespoke rule
 * would be far more machinery than one file scan. It is deliberately dumb: it
 * greps, so it cannot be fooled by mocking, and it costs milliseconds.
 *
 * If you are here because this test failed: do NOT just add your file. Use
 * `updateStatusIfNotTerminal` (pause / park / recovery / business outcome) or
 * `startRunIfNotTerminal` (the `running` flip).
 *
 * THE ONE CRITERION for an allowlist entry: the caller already holds the run
 * row's `SELECT … FOR UPDATE` lock and has re-checked `TERMINAL_RUN_STATUSES`
 * on that freshly-locked row INSIDE THE SAME TRANSACTION as the write. Record
 * the reason both here and in the docblock on
 * `db/repos/mission-runs.ts#updateStatus`.
 *
 * The criterion used to have a second limb — "or the caller writes the
 * `stopped`/`user_stopped` pair itself, so it cannot violate an invariant about
 * that pair" — and it was WRONG. It exempted `abort.ts` and
 * `mission-finalize.ts` (stop-for-edit), which wrote exactly that pair from an
 * unlocked read and could therefore overwrite a committed ordinary Stop AND
 * demote its `cancelled` mission back to `draft`. The status pair is identical
 * on both paths; the parent-mission state is not. Writing the same value as the
 * invariant's subject proves nothing about whether you raced it, so that limb
 * is gone and both files now delegate to `apply-stop-for-edit.ts`.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Call sites permitted to use the unconditional `updateStatus`. Keep in sync
 * with the ALLOWLIST docblock on `db/repos/mission-runs.ts#updateStatus`, which
 * carries the justification for each entry.
 */
const ALLOWED_CALLERS: readonly string[] = [
  "vex-agent/engine/runtime/lease-and-status/apply-user-stop.ts",
  "vex-agent/engine/core/runner/mission-auto-retry.ts",
  // Stage A3 moved the approval enqueue TRANSACTION out of
  // `turn-loop-tool-batch/approval-stop.ts` into the seam the Vex Studio MCP
  // surface shares with the turn loop. The `paused_approval` write moved with
  // it, unchanged, so the allowlist entry moved too.
  "vex-agent/engine/core/approval-runtime/enqueue.ts",
];

/**
 * `updateStatus(` in any call shape — `missionRunsRepo.updateStatus(...)`,
 * a destructured `const { updateStatus } = ...`, or a named
 * `import { updateStatus }`. Widened from the original `\.updateStatus\s*\(`,
 * which matched only the namespace-property shape and would have let a plain
 * named import through unseen.
 *
 * `updateStatusIfNotTerminal(` does not contain the substring `updateStatus(`,
 * so the guarded helper is excluded without a negative lookahead.
 *
 * KNOWN LIMITATION (accepted, not a gap worth more machinery): a caller that
 * renames the import (`updateStatus as writeStatus`) or reaches it through a
 * computed property (`repo["update" + "Status"]`) still evades the scan. Both
 * are deliberate obfuscation rather than the accident this guard exists to
 * catch, and closing them properly means a type-aware lint rule, not a grep.
 */
const UNCONDITIONAL_CALL = /\bupdateStatus\s*\(/;

/** Comments describe call sites all over this codebase; only code counts. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("mission_runs.status — `updateStatus` call-site allowlist", () => {
  it("has no `updateStatus` caller outside the documented allowlist (raw-SQL status writes are NOT scanned)", () => {
    const offenders: string[] = [];

    for (const file of collectTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      // The repo module DEFINES the function; it is not a caller.
      if (rel === "vex-agent/db/repos/mission-runs.ts") continue;

      const code = stripComments(readFileSync(file, "utf8"));
      // Only files that actually reach the mission-runs repo can call it.
      if (!code.includes("db/repos/mission-runs.js")) continue;
      if (!UNCONDITIONAL_CALL.test(code)) continue;
      if (ALLOWED_CALLERS.includes(rel)) continue;
      offenders.push(rel);
    }

    expect(
      offenders,
      "New unconditional `missionRunsRepo.updateStatus` call site(s). A terminal "
        + "user Stop must never be overwritten — use `updateStatusIfNotTerminal` "
        + "or `startRunIfNotTerminal`, or justify an allowlist entry here AND in "
        + "the docblock on `db/repos/mission-runs.ts#updateStatus`.",
    ).toEqual([]);
  });

  it("lists no stale allowlist entries", () => {
    // A stale entry is how an allowlist rots into a rubber stamp: the caller is
    // fixed or deleted, the exemption stays, and the next file to take that path
    // inherits it silently.
    const stale = ALLOWED_CALLERS.filter((rel) => {
      const code = stripComments(readFileSync(join(SRC_ROOT, rel), "utf8"));
      return !UNCONDITIONAL_CALL.test(code);
    });
    expect(stale).toEqual([]);
  });
});
