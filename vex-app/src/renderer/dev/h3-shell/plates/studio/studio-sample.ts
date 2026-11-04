/**
 * THE STUDIO PLATES' SAMPLE CONTENT - every word and figure the plates draw
 * that is not a real part's own (S8-01).
 *
 * A PLATE'S, NEVER THE APP'S. Nothing here is read from a bridge, a project
 * or a terminal: the projects, the tree, the shell sessions and the host's
 * figures are made up to show the layout, in the shapes the real sources
 * have (`ProjectDto`, the explorer's nodes, the terminal tab model's four
 * states, `studioHostStatusWord`'s state and figures). The app's own words
 * the plates propose are marked "proposed" where they are new.
 *
 * Words are in sentence case; the plate's sheet sets the caps, as the app's
 * label register does (docs/design/H3-DESKTOP.md section 2.3).
 */

import type { TerminalTabRunState } from "../../../../features/appShell/studio/terminal/terminal-tab-model.js";

/* -------------------------------- projects -------------------------------- */

export interface SampleProject {
  readonly name: string;
  /** A shell of the project's is live (the project row's square and word). */
  readonly running: boolean;
}

/** The open project, as the header's title cell and This project name it. */
export const SAMPLE_PROJECT = {
  name: "vex-core",
  /** `ProjectDto.permission`; the header's line reads "Studio · Full access". */
  permission: "full",
  displayPath: "~/Vex/projects/vex-core",
  agents: "Claude Code, Codex CLI",
  wallet: "Main wallet",
  walletAddress: "0x7e57…b45e",
} as const;

/** The projects list: the open one first, three shown of four. */
export const SAMPLE_PROJECTS: readonly SampleProject[] = [
  { name: "vex-core", running: true },
  { name: "trading-agent", running: false },
  { name: "wallet-tools", running: false },
];
export const SAMPLE_PROJECT_TOTAL = 4;

/* -------------------------------- explorer -------------------------------- */

export interface SampleTreeRow {
  readonly name: string;
  readonly depth: number;
  /** A folder, and whether it is open; a file has none. */
  readonly folder?: "open" | "closed";
}

export const SAMPLE_TREE: readonly SampleTreeRow[] = [
  { name: ".codex", depth: 0, folder: "closed" },
  { name: ".vex", depth: 0, folder: "closed" },
  { name: "src", depth: 0, folder: "open" },
  { name: "wallet", depth: 1, folder: "closed" },
  { name: "alpha.ts", depth: 1 },
  { name: "beta.ts", depth: 1 },
  { name: ".mcp.json", depth: 0 },
  { name: "AGENTS.md", depth: 0 },
  { name: "CLAUDE.md", depth: 0 },
  { name: "README.md", depth: 0 },
  { name: "package.json", depth: 0 },
  { name: "tsconfig.json", depth: 0 },
];

/* ------------------------------- the host ------------------------------- */

/** The Studio host's state and figures, as `studioHostStatusWord` reads them. */
export const SAMPLE_HOST = { state: "running", connected: 2, max: 16 } as const;

/* ------------------------------- terminals ------------------------------- */

export interface SampleTab {
  readonly title: string;
  readonly kind: "terminal" | "file";
  /** A terminal tab's state (`terminal-tab-model.ts`); a file tab has none. */
  readonly state?: TerminalTabRunState;
  /** A preview file tab: its title in italics, as the strip draws it today. */
  readonly preview?: boolean;
}

/**
 * One line of a terminal, as runs of text. `t` is the run's role: the
 * prompt's path, the prompt mark, what the person typed, the program's
 * output, a muted line, and the ANSI green and red a test runner prints.
 */
export type TermRole = "path" | "mark" | "cmd" | "out" | "dim" | "ok" | "bad";
export type TermLine = readonly (readonly [TermRole, string])[];

/** zsh's prompt with the directory's last part (`%1~ %#`). */
const PROMPT: TermLine = [
  ["path", "vex-core"],
  ["mark", " % "],
];

function prompt(cmd: string): TermLine {
  return [...PROMPT, ["cmd", cmd]];
}

function out(text: string): TermLine {
  return [["out", text]];
}

/** Plate 1: one shell at its prompt, after a listing and the project's MCP file. */
export const SAMPLE_SESSION: readonly TermLine[] = [
  prompt("git status --short"),
  out(" M src/alpha.ts"),
  out("?? src/beta.ts"),
  prompt("ls -la"),
  out("total 40"),
  out("drwxr-xr-x  12 you  staff   384 Nov  4 14:02 ."),
  out("drwxr-xr-x   5 you  staff   160 Aug 31 11:30 .."),
  out("drwxr-xr-x   3 you  staff    96 Aug 31 11:30 .codex"),
  out("-rw-r--r--   1 you  staff   176 Aug 31 11:30 .mcp.json"),
  out("drwxr-xr-x   3 you  staff    96 Aug 31 11:30 .vex"),
  out("-rw-r--r--   1 you  staff  3412 Aug 31 11:30 AGENTS.md"),
  out("-rw-r--r--   1 you  staff   214 Aug 31 11:30 CLAUDE.md"),
  out("-rw-r--r--   1 you  staff   512 Nov  4 14:02 README.md"),
  out("-rw-r--r--   1 you  staff   698 Nov  4 13:40 package.json"),
  out("drwxr-xr-x   6 you  staff   192 Nov  4 14:02 src"),
  out("-rw-r--r--   1 you  staff   341 Nov  4 14:02 tsconfig.json"),
  prompt("cat .mcp.json"),
  out("{"),
  out('  "mcpServers": {'),
  out('    "vex": {'),
  out('      "command": "~/.config/vex/bin/vex-mcp",'),
  out('      "args": ["--project", "0f6b1c2e-8a4d-4f1b-9c3e-7d5a2b8e4c10"]'),
  out("    }"),
  out("  }"),
  out("}"),
  PROMPT,
];

/** Plate 2, the left pane: a test run still going, at the pane's 41 columns. */
export const SAMPLE_RUNNING: readonly TermLine[] = [
  prompt("pnpm vitest run src"),
  out(""),
  [["dim", " RUN "], ["out", " v3.2.4 ~/Vex/projects/vex-core"]],
  out(""),
  [["ok", " ✓ "], ["out", "src/alpha.test.ts "], ["dim", "(12 tests) 41ms"]],
  [["ok", " ✓ "], ["out", "src/beta.test.ts "], ["dim", "(8 tests) 28ms"]],
  [["ok", " ✓ "], ["out", "src/wallet/quote.test.ts "], ["dim", "(21 tests)"]],
  [["bad", " × "], ["out", "src/wallet/fees.test.ts "], ["dim", "(1 failed)"]],
  [["bad", "   × "], ["out", "rounds the fee to the decimals"]],
  [["out", " ❯ "], ["out", "src/wallet/route.test.ts "], ["dim", "(2 running)"]],
  [["ok", "   ✓ "], ["out", "picks the cheapest route"]],
  [["ok", "   ✓ "], ["out", "refuses a route over the limit"]],
  [["dim", "   ⋯ "], ["out", "retries a timed-out quote"]],
  [["dim", "   ⋯ "], ["out", "reads the chain from the call"]],
  out(""),
  [["dim", " Test Files  "], ["ok", "3 passed"], ["dim", " | "], ["bad", "1 failed"], ["dim", " (5)"]],
  [["dim", "      Tests  "], ["ok", "53 passed"], ["dim", " | "], ["bad", "1 failed"], ["dim", " (61)"]],
  [["dim", "   Start at  "], ["out", "14:12:06"]],
  [["dim", "   Duration  "], ["out", "2.41s"]],
];

/** Plate 2, the right pane: a shell at its prompt. */
export const SAMPLE_IDLE: readonly TermLine[] = [
  prompt("git log --oneline -5"),
  [["dim", "3f2a9c1 "], ["out", "Quote through the cheapest venue"]],
  [["dim", "a81d0e4 "], ["out", "Read the chain from the call"]],
  [["dim", "5c77b20 "], ["out", "Add the slippage limit"]],
  [["dim", "91be3d7 "], ["out", "Write the project's MCP file"]],
  [["dim", "0e19f3a "], ["out", "Start the project"]],
  prompt("git status --short"),
  out(" M src/alpha.ts"),
  out("?? src/beta.ts"),
  PROMPT,
];
