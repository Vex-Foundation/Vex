/**
 * The two rules behind a terminal tab: what it is called, and what state it is
 * in.
 *
 * Both are pure functions of data, so they are tested as tables rather than
 * through a rendered strip - the same split VS Code draws between
 * `TerminalLabelComputer` (a table test over inputs, `terminalInstance.test.ts`)
 * and the tab list that renders its result. The rendered half - that the state
 * reaches assistive technology as a word and that the dot is decoration - lives
 * in `TerminalTabs.test.tsx`, where a DOM exists to assert it on.
 */

import { describe, expect, it } from "vitest";
import type { TerminalWorkspaceRestore } from "@shared/schemas/terminal.js";
import type {
  WorkspaceState,
  WorkspaceTab,
  WorkspaceTerminalGroup,
} from "../../workspace/types.js";
import {
  nextTerminalTitle,
  renumberTerminalTabs,
  shellLabelsOf,
  terminalGroupIsLive,
  terminalGroupRunState,
  type TerminalRunFacts,
} from "../terminal-tab-model.js";

function group(tabId: string, title: string, terminalIds: readonly string[]): WorkspaceTerminalGroup {
  return {
    kind: "terminalGroup",
    tabId,
    title,
    orientation: "horizontal",
    panes: terminalIds.map((terminalId, index) => ({
      paneId: `${tabId}:${String(index)}`,
      terminalId,
      relativeSize: 1 / terminalIds.length,
      displayCwd: null,
    })),
    activePaneId: `${tabId}:0`,
  };
}

function file(tabId: string, title: string): WorkspaceTab {
  return {
    kind: "file",
    tabId,
    title,
    relativePath: `src/${title}`,
    nodeId: `node-${tabId}`,
    dirty: false,
  };
}

function facts(overrides: Partial<TerminalRunFacts> = {}): TerminalRunFacts {
  return {
    lostTerminalIds: new Set<string>(),
    exits: new Map(),
    restoring: false,
    ...overrides,
  };
}

describe("naming a new terminal", () => {
  it("starts at Terminal 1 in an empty workspace", () => {
    expect(nextTerminalTitle([])).toBe("Terminal 1");
  });

  it("takes the next number, so two open terminals are never both Terminal 1", () => {
    expect(nextTerminalTitle([group("g1", "Terminal 1", ["t1"])])).toBe("Terminal 2");
  });

  it("fills a GAP rather than counting the tabs", () => {
    // Counting would hand out `Terminal 2` a second time here, which is the
    // exact ambiguity numbering exists to remove.
    const tabs = [group("g1", "Terminal 1", ["t1"]), group("g3", "Terminal 3", ["t3"])];
    expect(nextTerminalTitle(tabs)).toBe("Terminal 2");
  });

  it("frees a number when its tab closes, because nothing on screen holds it", () => {
    const tabs = [group("g2", "Terminal 2", ["t2"])];
    expect(nextTerminalTitle(tabs)).toBe("Terminal 1");
  });

  it("ignores a RENAMED tab's number, since the user's name no longer shows one", () => {
    const tabs = [group("g1", "dev server", ["t1"])];
    expect(nextTerminalTitle(tabs)).toBe("Terminal 1");
  });

  it("respects a FILE tab that happens to carry the name, since the strip is one list", () => {
    // Contrived, and answered the safe way: terminals and files share one tab
    // strip, so two tabs reading `Terminal 1` would be ambiguous to a user and
    // to anyone navigating by name, whichever kind owns the name.
    expect(nextTerminalTitle([file("f1", "Terminal 1")])).toBe("Terminal 2");
  });

  it("is not confused by a number-like suffix", () => {
    const tabs = [group("g1", "Terminal 1 (old)", ["t1"])];
    expect(nextTerminalTitle(tabs)).toBe("Terminal 1");
  });
});

describe("renumbering a restored workspace", () => {
  it("replaces the snapshot's shell names with Terminal n, in strip order", () => {
    const state: WorkspaceState = {
      projectId: "p1",
      activeTabId: "g1",
      tabs: [
        group("g1", "bash", ["t1"]),
        file("f1", "README.md"),
        group("g2", "bash", ["t2"]),
      ],
    };
    const renumbered = renumberTerminalTabs(state);
    expect(renumbered.tabs.map((tab) => tab.title)).toEqual([
      "Terminal 1",
      "README.md",
      "Terminal 2",
    ]);
    // Everything else about the state is untouched, including the selection.
    expect(renumbered.activeTabId).toBe("g1");
    expect(renumbered.tabs[0]?.tabId).toBe("g1");
  });

  it("keeps the shell each terminal was running, as a label rather than a name", () => {
    const restore: TerminalWorkspaceRestore = {
      layout: {
        projectId: "p1",
        activeGroupIndex: 0,
        groups: [
          {
            groupId: "g1",
            orientation: "horizontal",
            activePaneIndex: 0,
            panes: [
              { terminalId: "t1", relativeSize: 0.5 },
              { terminalId: "t2", relativeSize: 0.5 },
            ],
          },
        ],
      },
      terminals: [
        {
          terminalId: "t1",
          // The host reported a title, so that is what was running.
          title: "npm run dev",
          shellName: "bash",
          displayCwd: null,
          droppedRows: 0,
          reducedRows: 0,
        },
        {
          terminalId: "t2",
          // No title: the shell's own name is the honest fallback.
          title: "",
          shellName: "zsh",
          displayCwd: null,
          droppedRows: 0,
          reducedRows: 0,
        },
      ],
      idMap: [],
    };
    expect([...shellLabelsOf(restore)]).toEqual([
      ["t1", "npm run dev"],
      ["t2", "zsh"],
    ]);
  });
});

describe("the state a terminal tab is in", () => {
  it("is RUNNING while no pane has reported anything", () => {
    expect(terminalGroupRunState(group("g1", "Terminal 1", ["t1"]), facts())).toBe(
      "running",
    );
  });

  it("is EXITED only when EVERY pane has gone", () => {
    const split = group("g1", "Terminal 1", ["t1", "t2"]);
    const oneGone = facts({ exits: new Map([["t1", { exitCode: 0, signal: null }]]) });
    // A tab with one live shell in it is a live tab.
    expect(terminalGroupRunState(split, oneGone)).toBe("running");

    const bothGone = facts({
      exits: new Map([
        ["t1", { exitCode: 0, signal: null }],
        ["t2", { exitCode: 0, signal: null }],
      ]),
    });
    expect(terminalGroupRunState(split, bothGone)).toBe("exited");
  });

  it("is an ERROR when any settled pane failed", () => {
    const split = group("g1", "Terminal 1", ["t1", "t2"]);
    for (const bad of [
      { exitCode: 127, signal: null },
      { exitCode: 0, signal: 9 },
    ]) {
      const settled = facts({
        exits: new Map([
          ["t1", { exitCode: 0, signal: null }],
          ["t2", bad],
        ]),
      });
      // The dot is the only place a user looking at another tab would learn a
      // background pane fell over.
      expect(terminalGroupRunState(split, settled)).toBe("error");
    }
  });

  it("lets HOST LOSS win over an exit, because a taken shell did not exit", () => {
    const settled = facts({
      exits: new Map([["t1", { exitCode: 0, signal: null }]]),
      lostTerminalIds: new Set(["t1"]),
    });
    expect(terminalGroupRunState(group("g1", "Terminal 1", ["t1"]), settled)).toBe("error");
  });

  it("reads RESTORING while the repair for a lost shell runs, and only then", () => {
    const lost = group("g1", "Terminal 1", ["t1"]);
    expect(
      terminalGroupRunState(lost, facts({ lostTerminalIds: new Set(["t1"]), restoring: true })),
    ).toBe("restoring");
    // A restore never masks a tab it does not concern.
    expect(terminalGroupRunState(lost, facts({ restoring: true }))).toBe("running");
  });
});

describe("whether closing a tab would end a shell", () => {
  it("is true while any pane is neither lost nor exited", () => {
    const split = group("g1", "Terminal 1", ["t1", "t2"]);
    expect(terminalGroupIsLive(split, facts())).toBe(true);
    expect(
      terminalGroupIsLive(
        split,
        facts({ exits: new Map([["t1", { exitCode: 0, signal: null }]]) }),
      ),
    ).toBe(true);
  });

  it("is false once every pane is settled or lost, so the close stops warning", () => {
    const split = group("g1", "Terminal 1", ["t1", "t2"]);
    expect(
      terminalGroupIsLive(
        split,
        facts({
          exits: new Map([["t1", { exitCode: 0, signal: null }]]),
          lostTerminalIds: new Set(["t2"]),
        }),
      ),
    ).toBe(false);
  });
});
