/**
 * The agent has no shell.
 *
 * Every `VexError.hint` is written FOR the model — it is the one field the
 * error surface promises is agent-actionable. A hint that says "Run `vex
 * khalani chains --json`" or "retry with --deposit-method CONTRACT_CALL"
 * therefore costs a turn twice over: the agent cannot run it, and the flag it
 * names is not what the tool parameter is called (`depositMethod`). This suite
 * is the ratchet — a CLI hint added to any of these modules fails here.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Modules whose error text reaches the agent through a tool result. */
const AGENT_FACING_ERROR_MODULES = [
  "src/tools/khalani/chains.ts",
  "src/tools/khalani/balances/_shared.ts",
  "src/tools/khalani/bridge-executor/deposit-plan.ts",
  "src/tools/pendle/errors.ts",
  "src/vex-agent/tools/protocols/khalani/handlers/read.ts",
];

/** The message/hint string literals of a module, as authored. */
function authoredStrings(relativePath: string): string[] {
  const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .flatMap((line) => line.match(/"[^"]*"|`[^`]*`/g) ?? []);
}

describe("agent-facing error text carries no CLI syntax", () => {
  it.each(AGENT_FACING_ERROR_MODULES)("%s invokes no `vex` command", (path) => {
    for (const literal of authoredStrings(path)) {
      expect(literal, `${path}: ${literal}`).not.toMatch(/\bvex [a-z]/);
    }
  });

  it.each(AGENT_FACING_ERROR_MODULES)("%s names no `--flag`", (path) => {
    for (const literal of authoredStrings(path)) {
      expect(literal, `${path}: ${literal}`).not.toMatch(/(^|\s)--[a-z]/);
    }
  });

  it.each(AGENT_FACING_ERROR_MODULES)("%s asks nobody to 'report this'", (path) => {
    for (const literal of authoredStrings(path)) {
      // There is no recipient: the agent has no issue tracker and no operator
      // channel from inside a tool call.
      expect(literal.toLowerCase(), `${path}: ${literal}`).not.toContain("report this");
    }
  });
});
