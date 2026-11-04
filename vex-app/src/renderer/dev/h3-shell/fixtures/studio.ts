/**
 * STUDIO FIXTURES - the projects, the explorer's tree, the Studio host and
 * the terminals the Studio states stand in for.
 *
 * FIXTURE DATA, NEVER SHOWN AS REAL. Every value is typed by the real DTO
 * (`ProjectDto`, the files bridge's listing, the terminal bridge's restore
 * and outcomes), so a contract change breaks this file at compile time. The
 * ids are valid v4 UUIDs in a block no real install mints (`48335000-...`),
 * the folder is a display label like the one main derives, and the terminal
 * text is made up to show the layout, in the shapes a shell prints.
 *
 * THE TERMINALS ARE A REPLAY, not a process. `attach` answers as the bridge
 * does and then delivers the terminal's screen through `onResync` and
 * `onData`, the way preload delivers a replay (`TerminalBridge.attach`): a
 * resync to clear, then the text. Nothing runs, nothing is written anywhere,
 * and a keystroke the harness's xterm sends is acknowledged and dropped.
 */

import type { FileListing, FileNode, FilesOutcome, FilesSubscription } from "@shared/schemas/files.js";
import type { ProjectDto, ProjectList } from "@shared/schemas/projects.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import type {
  TerminalCreateResult,
  TerminalOutcome,
  TerminalShellCatalogue,
  TerminalWorkspaceRestore,
} from "@shared/schemas/terminal.js";
import { ok, type BridgeAnswers } from "../bridge.js";
import { DAY, isoAt } from "../clock.js";
import { EVM_WALLET } from "./base.js";
import { fixture } from "../mark.js";

const projectId = (n: number): string => `48335000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function project(
  n: number,
  name: string,
  extra: Partial<ProjectDto> = {},
): ProjectDto {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    id: projectId(n),
    name,
    slug,
    rootPath: slug,
    displayPath: `~/Vex/projects/${slug}`,
    permission: "restricted",
    agents: [],
    wallets: { evm: null, solana: null },
    scopeVersion: 1,
    backingSessionId: `48335100-0000-4000-8000-${String(n).padStart(12, "0")}`,
    files: { lastRenderedScopeVersion: 1, generatorFingerprint: "h3-fixture", artifacts: [] },
    createdAt: isoAt(-30 * DAY),
    updatedAt: isoAt(-DAY),
    ...extra,
  };
}

/** The open project: full access, two agents, the base install's EVM wallet. */
export const STUDIO_PROJECT: ProjectDto = fixture(
  "studio.project",
  project(1, "vex-core", {
    permission: "full",
    agents: ["claude-code", "codex"],
    wallets: { evm: { id: EVM_WALLET.id, address: EVM_WALLET.address }, solana: null },
  }),
);

/** Four projects, the open one first. */
export const STUDIO_PROJECTS: ProjectList = fixture("studio.projects", [
  STUDIO_PROJECT,
  project(2, "trading-agent"),
  project(3, "wallet-tools"),
  project(4, "notes"),
]);

/* -------------------------------- explorer -------------------------------- */

function node(path: string, kind: FileNode["kind"]): FileNode {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { nodeId: `h3-node:${path}`, name, path, kind, size: kind === "file" ? 512 : null, modifiedMs: null };
}

/** The tree by parent node id (`null` is the root), in the listing's own order. */
const TREE: ReadonlyMap<string | null, readonly FileNode[]> = new Map<string | null, readonly FileNode[]>([
  [
    null,
    [
      node(".codex", "directory"),
      node(".vex", "directory"),
      node("src", "directory"),
      node(".mcp.json", "file"),
      node("AGENTS.md", "file"),
      node("CLAUDE.md", "file"),
      node("README.md", "file"),
      node("package.json", "file"),
      node("tsconfig.json", "file"),
    ],
  ],
  ["h3-node:src", [node("src/wallet", "directory"), node("src/alpha.ts", "file"), node("src/beta.ts", "file")]],
  ["h3-node:.codex", []],
  ["h3-node:.vex", []],
  ["h3-node:src/wallet", []],
]);

function listing(nodeId: string | null): FilesOutcome<FileListing> {
  const children = TREE.get(nodeId) ?? [];
  return {
    ok: true,
    value: { children: [...children], hasMore: false, nextCursor: null, totalCount: children.length, excludedCount: 0 },
  };
}

const SUBSCRIPTION: FilesSubscription = {
  subscriptionId: "h3-files-subscription",
  watcherGeneration: 0,
  state: "watching",
  warnings: [],
};

/* -------------------------------- the host -------------------------------- */

export const STUDIO_HOST: StudioHostStatus = fixture("studio.host", {
  state: "running",
  cause: null,
  connectionCount: 2,
  maxConnections: 16,
  atCapacity: false,
});

/* ------------------------------- terminals ------------------------------- */

const CATALOGUE: TerminalShellCatalogue = {
  shells: [
    { id: "zsh", label: "zsh", available: true },
    { id: "bash", label: "bash", available: true },
    { id: "fish", label: "fish", available: false },
  ],
  defaultShellId: "zsh",
};

const ESC = "\u001b[";
const DIM = `${ESC}90m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;
const PROMPT = `${DIM}vex-core${RESET} % `;

/** One shell at its prompt, after a listing and the project's MCP file. */
const SESSION = [
  `${PROMPT}git status --short`,
  " M src/alpha.ts",
  "?? src/beta.ts",
  `${PROMPT}ls -la`,
  "total 40",
  "drwxr-xr-x  12 you  staff   384 Nov  4 14:02 .",
  "drwxr-xr-x   5 you  staff   160 Aug 31 11:30 ..",
  "drwxr-xr-x   3 you  staff    96 Aug 31 11:30 .codex",
  "-rw-r--r--   1 you  staff   176 Aug 31 11:30 .mcp.json",
  "drwxr-xr-x   3 you  staff    96 Aug 31 11:30 .vex",
  "-rw-r--r--   1 you  staff  3412 Aug 31 11:30 AGENTS.md",
  "-rw-r--r--   1 you  staff   214 Aug 31 11:30 CLAUDE.md",
  "-rw-r--r--   1 you  staff   512 Nov  4 14:02 README.md",
  "-rw-r--r--   1 you  staff   698 Nov  4 13:40 package.json",
  "drwxr-xr-x   6 you  staff   192 Nov  4 14:02 src",
  "-rw-r--r--   1 you  staff   341 Nov  4 14:02 tsconfig.json",
  `${PROMPT}cat .mcp.json`,
  "{",
  '  "mcpServers": {',
  '    "vex": {',
  '      "command": "~/.config/vex/bin/vex-mcp",',
  `      "args": ["--project", "${projectId(1)}"]`,
  "    }",
  "  }",
  "}",
  PROMPT,
].join("\r\n");

/** A test run in its last stretch, with the ANSI green and red a runner prints. */
const RUNNING = [
  `${PROMPT}pnpm vitest run src`,
  "",
  ` ${BOLD}RUN${RESET}  v3.2.4 ~/Vex/projects/vex-core`,
  "",
  ` ${GREEN}✓${RESET} src/alpha.test.ts ${DIM}(12 tests) 41ms${RESET}`,
  ` ${GREEN}✓${RESET} src/beta.test.ts ${DIM}(8 tests) 28ms${RESET}`,
  ` ${GREEN}✓${RESET} src/wallet/quote.test.ts ${DIM}(21 tests)${RESET}`,
  ` ${RED}×${RESET} src/wallet/fees.test.ts ${DIM}(1 failed)${RESET}`,
  `   ${RED}× rounds the fee to the decimals${RESET}`,
  ` ❯ src/wallet/route.test.ts ${DIM}(2 running)${RESET}`,
  `   ${GREEN}✓${RESET} picks the cheapest route`,
  `   ${GREEN}✓${RESET} refuses a route over the limit`,
  "",
  ` ${DIM}Test Files${RESET}  ${BOLD}${GREEN}3 passed${RESET} ${DIM}|${RESET} ${BOLD}${RED}1 failed${RESET} ${DIM}(5)${RESET}`,
  `      ${DIM}Tests${RESET}  ${BOLD}${GREEN}53 passed${RESET} ${DIM}|${RESET} ${BOLD}${RED}1 failed${RESET} ${DIM}(61)${RESET}`,
  `   ${DIM}Start at${RESET}  14:12:06`,
  `   ${DIM}Duration${RESET}  2.41s`,
].join("\r\n");

/** A second shell at its prompt. */
const IDLE = [
  `${PROMPT}git log --oneline -3`,
  `${DIM}3f2a9c1${RESET} Quote through the cheapest venue`,
  `${DIM}a81d0e4${RESET} Read the chain from the call`,
  `${DIM}5c77b20${RESET} Add the slippage limit`,
  PROMPT,
].join("\r\n");

export interface StudioTerminalScene {
  /** The tabs, each a group of one or two panes, the first active. */
  readonly groups: readonly (readonly ("session" | "running" | "idle")[])[];
}

const SCREENS = { session: SESSION, running: RUNNING, idle: IDLE } as const;

type Listener = (...args: unknown[]) => void;

/**
 * The terminal and files namespaces for one scene. Listeners are kept per
 * terminal id, as preload keeps them, so a replay reaches the pane it names.
 */
export function studioTerminalAnswers(scene: StudioTerminalScene): BridgeAnswers {
  const listeners = new Map<string, Set<Listener>>();
  const listen = (kind: string) => (terminalId: string, cb: Listener): (() => void) => {
    const key = `${kind}:${terminalId}`;
    const set = listeners.get(key) ?? new Set<Listener>();
    set.add(cb);
    listeners.set(key, set);
    return () => {
      set.delete(cb);
    };
  };
  const fire = (kind: string, terminalId: string, ...args: unknown[]): void => {
    for (const cb of listeners.get(`${kind}:${terminalId}`) ?? []) cb(...args);
  };

  const screenById = new Map<string, string>();
  const groups = scene.groups.map((panes, g) => ({
    groupId: `h3-group-${String(g + 1)}`,
    orientation: "horizontal" as const,
    panes: panes.map((screen, p) => {
      const terminalId = `h3-term-${String(g + 1)}-${String(p + 1)}`;
      screenById.set(terminalId, SCREENS[screen]);
      return { terminalId, relativeSize: 1 / panes.length };
    }),
    activePaneIndex: 0,
  }));
  const restore: TerminalWorkspaceRestore = fixture("studio.terminals", {
    layout: { projectId: STUDIO_PROJECT.id, groups, activeGroupIndex: 0 },
    terminals: [...screenById.keys()].map((terminalId) => ({
      terminalId,
      title: "zsh",
      shellName: "zsh",
      displayCwd: STUDIO_PROJECT.displayPath,
      droppedRows: 0,
      reducedRows: 0,
    })),
    idMap: [],
  });

  const ack = (): Promise<{ ok: true; data: TerminalOutcome<null> }> =>
    ok<TerminalOutcome<null>>({ ok: true, value: null }) as Promise<{ ok: true; data: TerminalOutcome<null> }>;

  return {
    terminal: {
      getShellCatalogue: () => ok(CATALOGUE),
      getAvailability: () => ok({ state: "running", restartCount: 0, responsive: true }),
      onAvailability: () => () => undefined,
      onTerminalsLost: () => () => undefined,
      readWorkspace: () => ok<TerminalOutcome<TerminalWorkspaceRestore | null>>({ ok: true, value: restore }),
      persistWorkspace: ack,
      create: () =>
        ok<TerminalCreateResult>({
          ok: true,
          value: { terminalId: "h3-term-new", pid: 1, shellName: "zsh", displayCwd: STUDIO_PROJECT.displayPath },
        }),
      attach: ({ terminalId }) => {
        const screen = screenById.get(terminalId) ?? "";
        // The replay, as preload delivers it: a resync, then the screen.
        queueMicrotask(() => {
          fire("resync", terminalId, { reason: "replay", droppedRows: 0 });
          fire("data", terminalId, screen, () => undefined);
        });
        return ack();
      },
      detach: ack,
      write: ack,
      resize: ack,
      kill: ack,
      onData: listen("data") as never,
      onResync: listen("resync") as never,
      onProperty: listen("property") as never,
      onExit: listen("exit") as never,
      onRefused: listen("refused") as never,
    },
    files: {
      listChildren: ({ nodeId }) => ok(listing(nodeId)),
      watchFile: () => ok<FilesOutcome<FilesSubscription>>({ ok: true, value: SUBSCRIPTION }),
      unwatchFile: () => ok<FilesOutcome<null>>({ ok: true, value: null }),
      onFilesEvent: () => () => undefined,
    },
    projects: {
      list: () => ok(STUDIO_PROJECTS),
      get: ({ projectId: id }) => ok(STUDIO_PROJECTS.find((p) => p.id === id) ?? null),
      pendingCleanups: () => ok({ items: [], nextOffset: null }),
    },
    studio: {
      getHostStatus: () => ok(STUDIO_HOST),
      onHostStatus: () => () => undefined,
      // The bridge binary is installed: the workspace shows no readiness panel.
      getBridgeReadiness: () => ok({ kind: "ready" }),
    },
  };
}
