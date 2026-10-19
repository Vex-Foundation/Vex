/**
 * Why a bundled pg_dump / pg_restore run failed, in the lines that say so.
 *
 * With `--exit-on-error` pg_restore prints its error first and then the whole
 * statement it was running ("Command was: CREATE TABLE ... );"), so the end of
 * its stderr is SQL, not the cause. The shapes, captured from the bundled
 * 18.6 tools, are in `__tests__/pg-client-tool-stderr.ts`.
 *
 * The server's `DETAIL:` and `CONTEXT:` lines are left out on purpose: for a
 * failed COPY they quote the row ("Failing row contains (...)"), and this
 * summary goes to the app log. The complete stderr is kept beside the
 * runtime by `failed-attempt.ts`.
 */

export type PgClientTool = "pg_dump" | "pg_restore";

const SERVER_CAUSE_RE = /^(ERROR|FATAL|PANIC|HINT):/;
const COMMAND_WAS = "Command was: ";

export function pgToolFailureSummary(
  tool: PgClientTool,
  result: { readonly code: number | null; readonly stderr: string },
): string {
  const lines = result.stderr.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const toolPrefix = `${tool}: `;
  const kept: string[] = [];
  // libpq continues an error on tab-indented lines.
  let continuing = false;
  let statement: { readonly head: string; more: number } | null = null;
  const closeStatement = (): void => {
    if (statement === null) return;
    kept.push(
      statement.more === 0
        ? `statement: ${statement.head}`
        : `statement: ${statement.head} [${String(statement.more)} more line${statement.more === 1 ? "" : "s"}]`,
    );
    statement = null;
  };
  for (const line of lines) {
    if (statement !== null && !line.startsWith(toolPrefix)) {
      if (line.trim().length > 0) statement.more += 1;
      continue;
    }
    if (continuing && /^\s/.test(line) && line.trim().length > 0) {
      kept.push(line.trim());
      continue;
    }
    continuing = false;
    closeStatement();
    if (line.startsWith(toolPrefix) && !line.startsWith(`${toolPrefix}warning: `)) {
      kept.push(line);
      continuing = true;
    } else if (SERVER_CAUSE_RE.test(line)) {
      kept.push(line);
    } else if (line.startsWith(COMMAND_WAS)) {
      statement = { head: line.slice(COMMAND_WAS.length), more: 0 };
    }
  }
  closeStatement();
  if (kept.length > 0) return kept.join(" | ");
  const text = lines.join("\n").trim();
  if (text.length > 0) return text.split("\n").join(" | ");
  return result.code === null
    ? `${tool} was stopped before it finished and printed nothing`
    : `${tool} exited with code ${String(result.code)} and printed nothing`;
}
