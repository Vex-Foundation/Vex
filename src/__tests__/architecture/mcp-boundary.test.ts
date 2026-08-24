/**
 * STUDIO MCP IMPORT-DIRECTION GATE (Vex Studio stage A2).
 *
 * Three directions must stay closed for `src/vex-agent/mcp/**`, and each one is
 * a real property of the design rather than tidiness:
 *
 *  1. NO `db/repos/sessions` (or any project-table repo). The engine is
 *     deliberately unaware of project persistence: main owns `projects` and
 *     `project_wallets` and hands the executor a VALIDATED `ProjectScope`
 *     value. An import here would create a second reader of that state and a
 *     second answer to "what is this project's scope".
 *
 *  2. NO `vex-app/**`. The engine package cannot depend on the desktop app -
 *     the root `tsconfig.json` has no alias for it, and the dependency arrow
 *     runs app -> engine, never back.
 *
 *  3. NO `dispatcher/tool-search*`. That is the in-app ToolSearch lane: it owns
 *     `select:` mode and the per-session working set. The exported catalog
 *     search must be able to neither, which is why the shared row projection
 *     was moved to `protocols/discovery/rows.ts`. If this ever fails, move the
 *     shared code down into `protocols/`, do not relax the gate.
 *
 * MECHANISM: scan IMPORT statements only (static, `export … from`, and dynamic
 * `import("...")`), so a path named in a comment or a message string never
 * false-positives. Pure / no DB.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const MCP_DIR = resolve(REPO_ROOT, "src", "vex-agent", "mcp");

interface BannedImport {
  readonly label: string;
  readonly pattern: RegExp;
}

const BANNED: readonly BannedImport[] = [
  { label: "session/project persistence repo", pattern: /db\/repos\/sessions/ },
  { label: "the desktop app package", pattern: /(^|["'/])vex-app\// },
  { label: "the in-app ToolSearch dispatch lane", pattern: /dispatcher\/tool-search/ },
];

/** Every module specifier imported by one source file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const staticFrom = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
  const bareImport = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticFrom, bareImport, dynamic]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) specs.push(match[1]!);
  }
  return specs;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__" && entry !== "node_modules") files.push(...listSourceFiles(full));
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("src/vex-agent/mcp import-direction gate", () => {
  it("imports no forbidden module", () => {
    const files = listSourceFiles(MCP_DIR);
    // Sanity: the walker actually found the Studio MCP source tree.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specs = importSpecifiers(readFileSync(file, "utf8"));
      for (const spec of specs) {
        for (const banned of BANNED) {
          if (banned.pattern.test(spec)) {
            offenders.push(
              `${file.slice(REPO_ROOT.length + 1)} imports "${spec}" (${banned.label})`,
            );
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // Detector self-tests, so a future refactor cannot silently stop catching a
  // real wiring.
  it("flags each forbidden direction on synthetic source", () => {
    const cases = [
      'import { getSession } from "@vex-agent/db/repos/sessions.js";',
      'import { x } from "../../../vex-app/src/shared/schemas/projects.js";',
      'const s = await import("../tools/dispatcher/tool-search-select.js");',
      'export { handleToolSearch } from "../tools/dispatcher/tool-search.js";',
    ];
    for (const source of cases) {
      const specs = importSpecifiers(source);
      expect(specs).toHaveLength(1);
      expect(BANNED.some((b) => b.pattern.test(specs[0]!))).toBe(true);
    }
  });

  it("does not over-match a legitimate protocol import", () => {
    const specs = importSpecifiers(
      'import { toQueryRow } from "../tools/protocols/discovery/rows.js";',
    );
    expect(BANNED.some((b) => b.pattern.test(specs[0]!))).toBe(false);
  });
});
