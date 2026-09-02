/**
 * A STRUCTURAL PROGRESS TRACE FOR THE WINDOWS LANE, AND NOWHERE ELSE.
 *
 * ## Why this exists
 *
 * `real-pty.test.ts` killed its vitest fork worker on the Windows lane (run
 * 33623840152). A worker that dies natively - a killed process, a crashed
 * native module - prints NOTHING: vitest reports each test's result only after
 * that test's hooks have run, so a death inside `afterEach` erases the result
 * of the test that just ran too. The lane's log therefore showed eight files
 * completing, then thirty seconds of silence, then "Worker exited
 * unexpectedly", with not one case of the ninth file named. There was no way to
 * tell a module-load failure from a spawn failure from a hook failure.
 *
 * Worker stderr is forwarded by vitest whether or not the worker survives to
 * report anything, so a line written here is on the lane's log even when the
 * process is terminated a moment later. That makes the trace the ONLY signal
 * that survives the failure mode it exists to diagnose.
 *
 * ## What it may carry
 *
 * PHASE NAMES AND COUNTS, never payload. Nothing from a pty's data stream, a
 * shell's environment or a snapshot reaches this sink - the suite spawns real
 * shells with the user's scrubbed environment, and a CI log is a public
 * artifact. Callers pass string literals and small integers.
 *
 * ## Removal condition
 *
 * This is evidence tooling, not a product surface. Delete it - and the calls -
 * once the Windows `src/pty-host` lane has been green TWICE in a row. Tracked
 * in the studio-prod ledger under "B3r2-l: Windows real-pty trace".
 */

/**
 * The gate. Every write below is behind it, so a POSIX run's output is
 * byte-for-byte what it was before this file existed.
 */
const ENABLED = process.platform === "win32";

const startedAt = Date.now();

/**
 * Record that the suite reached `phase`.
 *
 * The elapsed millisecond count is the point: the lane's failure was "thirty
 * seconds of silence", and only a timestamped last line says which phase spent
 * them.
 */
export function traceWindowsPhase(phase: string): void {
  if (!ENABLED) return;
  process.stderr.write(
    `[real-pty] +${String(Date.now() - startedAt)}ms ${phase}\n`,
  );
}
