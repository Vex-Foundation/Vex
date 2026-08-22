/**
 * The gate's own regression test, and it exists for ONE reason: the untracked
 * lane.
 *
 * A merge-base `git diff` cannot see a file that was never staged, so a purely
 * diff-scoped gate reports green on a brand-new authored file full of em
 * dashes. That is exactly how the violation this gate was written for reached
 * the tree. The two cases below run the real script against a throwaway git
 * repository whose only content is untracked, so a regression that drops the
 * `git ls-files --others` lane turns this test red.
 *
 * The em dash is built from its code point, never written literally: a literal
 * here would make this file trip the very gate it tests.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const EM_DASH = String.fromCharCode(0x2014);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let sandbox: string;

/** Runs the gate in the sandbox. Returns the exit code and merged output. */
function runGate(): { readonly code: number; readonly output: string } {
  try {
    const stdout = execFileSync(process.execPath, [path.join(sandbox, "scripts/check-no-em-dash.mjs")], {
      cwd: sandbox,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function git(...args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: sandbox, encoding: "utf8", stdio: "ignore" });
}

function writeSandboxFile(relative: string, contents: string): void {
  const absolute = path.join(sandbox, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "vex-em-dash-gate-"));
  git("init", "--initial-branch", "main");
  git("config", "user.email", "gate@test.local");
  git("config", "user.name", "gate");
  writeSandboxFile("scripts/.keep", "");
  copyFileSync(path.join(repositoryRoot, "scripts/check-no-em-dash.mjs"), path.join(sandbox, "scripts/check-no-em-dash.mjs"));
  git("add", "-A");
  git("commit", "-m", "base");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("check-no-em-dash", () => {
  it("fails on an untracked authored file containing an em dash", () => {
    writeSandboxFile("src/dirty.ts", `export const copy = "a clause${EM_DASH}and another";\n`);
    const result = runGate();
    rmSync(path.join(sandbox, "src/dirty.ts"));
    expect(result.code).toBe(1);
    expect(result.output).toContain("src/dirty.ts:1");
  });

  it("passes on an untracked authored file with no em dash", () => {
    writeSandboxFile("src/clean.ts", 'export const copy = "a clause - and another";\n');
    const result = runGate();
    rmSync(path.join(sandbox, "src/clean.ts"));
    expect(result.code).toBe(0);
    expect(result.output).toContain("no em dashes");
  });

  it("ignores generated toolsnaps output", () => {
    writeSandboxFile("src/vex-agent/tools/__toolsnaps__/thing.json", `{ "description": "a${EM_DASH}b" }\n`);
    const result = runGate();
    rmSync(path.join(sandbox, "src/vex-agent/tools/__toolsnaps__"), { recursive: true });
    expect(result.code).toBe(0);
  });
});
