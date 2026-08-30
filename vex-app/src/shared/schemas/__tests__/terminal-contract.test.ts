/**
 * THE CONTRACT ITSELF: the bounds' relationships, and the strictness that keeps
 * an off-contract packet from crossing a process boundary.
 *
 * The first test is the one worth reading. `CharCountAckSize <= LowWatermark`
 * is an invariant VS Code writes on the constant in prose, and violating it
 * produces a terminal that pauses once and never resumes - with no error, no
 * log and no crash. Prose cannot fail a build; this can.
 */

import { describe, expect, it } from "vitest";
import {
  PTY_HOST_CONFIG_KEYS,
  SNAPSHOT_DIR_MAX_BYTES,
  TERMINALS_GLOBAL_MAX,
  TERMINALS_PER_PROJECT_MAX,
  TERMINAL_ACK_CHARS,
  TERMINAL_CREATE_TIMEOUT_MS,
  TERMINAL_DETACH_GRACE_MS,
  TERMINAL_DETACH_SHORT_GRACE_MS,
  TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
  TERMINAL_FLOW_LOW_WATERMARK_CHARS,
  TERMINAL_KILL_SETTLE_MS,
  TERMINAL_PENDING_CEILING_BYTES,
  TERMINAL_SNAPSHOT_MAX_BYTES,
  TERMINAL_SNAPSHOT_VERSION,
  TERMINAL_WRITE_MAX_BYTES,
  WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
  ptyHostEnvironment,
  terminalGroupLayoutSchema,
  terminalHostEnvelopeSchema,
  terminalPortEventSchema,
  terminalPortRequestSchema,
  terminalSnapshotEntrySchema,
  terminalSnapshotFileName,
  terminalWorkspaceLayoutSchema,
  terminalWorkspaceSnapshotSchema,
  terminalWriteInputSchema,
  utf8ByteLength,
} from "../terminal.js";

/* ------------------------------------------------------------------ *
 * Fixture builders for the persistence contract.
 *
 * Every builder returns a PLAIN object literal, never a typed value cast into
 * an invalid shape: `safeParse` takes `unknown`, so an off-contract fixture
 * needs no `as never` / `as unknown as` escape, and the tests below stay honest
 * about what the parser actually receives from a file on disk.
 * ------------------------------------------------------------------ */

function snapshotEntry(terminalId: string, serialized = "") {
  return {
    terminalId,
    title: "bash",
    shellName: "bash",
    executable: "/bin/bash",
    args: [],
    cwdAtSpawn: "/p",
    cols: 80,
    rows: 24,
    serialized,
    droppedRows: 0,
    reducedRows: 0,
  };
}

function pane(terminalId: string) {
  return { terminalId, relativeSize: 1 };
}

function group(groupId: string, terminalIds: readonly string[], activePaneIndex = 0) {
  return {
    groupId,
    orientation: "horizontal",
    panes: terminalIds.map(pane),
    activePaneIndex,
  };
}

function workspaceSnapshot(
  projectId: string,
  layout: unknown,
  terminals: readonly unknown[],
) {
  return {
    version: TERMINAL_SNAPSHOT_VERSION,
    projectId,
    savedAt: 0,
    layout,
    terminals,
  };
}

describe("bound relationships", () => {
  it("keeps the ack unit at or below the low watermark, or a paused pty never resumes", () => {
    expect(TERMINAL_ACK_CHARS).toBeLessThanOrEqual(TERMINAL_FLOW_LOW_WATERMARK_CHARS);
  });

  it("keeps the low watermark below the high one", () => {
    expect(TERMINAL_FLOW_LOW_WATERMARK_CHARS).toBeLessThan(
      TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
    );
  });

  it("keeps flow control reachable well before the emergency ceiling", () => {
    // The ceiling is the LAST resort. If the high watermark could hold more
    // bytes than the ceiling, the ceiling would be the primary mechanism and
    // every busy terminal would be detached instead of paced.
    expect(TERMINAL_FLOW_HIGH_WATERMARK_CHARS * 4).toBeLessThan(
      TERMINAL_PENDING_CEILING_BYTES,
    );
  });

  it("keeps a single terminal's snapshot smaller than a project's file", () => {
    expect(TERMINAL_SNAPSHOT_MAX_BYTES * TERMINALS_PER_PROJECT_MAX).toBeGreaterThan(
      WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
    );
    expect(TERMINAL_SNAPSHOT_MAX_BYTES).toBeLessThan(
      WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
    );
  });

  it("keeps a project's snapshot file smaller than the directory bound", () => {
    expect(WORKSPACE_SNAPSHOT_FILE_MAX_BYTES).toBeLessThan(SNAPSHOT_DIR_MAX_BYTES);
  });

  it("keeps the global terminal bound at or above one project's", () => {
    expect(TERMINALS_GLOBAL_MAX).toBeGreaterThanOrEqual(TERMINALS_PER_PROJECT_MAX);
  });

  it("keeps the deliberate-close grace shorter than the reload grace", () => {
    // A user who closed the window meant it; holding their shells for a full
    // minute afterwards leaks processes they believe they ended.
    expect(TERMINAL_DETACH_SHORT_GRACE_MS).toBeLessThan(TERMINAL_DETACH_GRACE_MS);
  });

  it("keeps the kill settle window strictly under the control-request timeout", () => {
    // `TERMINAL_CREATE_TIMEOUT_MS` bounds every control request, kill included.
    // A settle window at or above it would make a slow-but-normal kill - a pty
    // that takes its time exiting - indistinguishable from an unresponsive
    // host: main would time the request out and declare the host dead for
    // doing exactly what it was asked to do.
    expect(TERMINAL_KILL_SETTLE_MS).toBeLessThan(TERMINAL_CREATE_TIMEOUT_MS);
  });
});

describe("the pty host's boot environment", () => {
  it("sets exactly the keys the host deletes - no more, no fewer", () => {
    // A key main sets that the host does not delete is a key exported into
    // every shell the user opens. A key the host reads that main never sets is
    // a silent fallback nobody chose.
    expect(Object.keys(ptyHostEnvironment("/tmp/x")).sort()).toEqual(
      [...PTY_HOST_CONFIG_KEYS].sort(),
    );
  });
});

describe("write bound", () => {
  it("measures BYTES, not characters", () => {
    // A four-byte character is one `.length` unit, so a chars-only bound would
    // let a payload four times the intended size through.
    const wide = "\u{1F600}".repeat(TERMINAL_WRITE_MAX_BYTES / 4);
    expect(utf8ByteLength(wide)).toBe(TERMINAL_WRITE_MAX_BYTES);
    expect(
      terminalWriteInputSchema.safeParse({ terminalId: "t1", data: wide }).success,
    ).toBe(true);
    expect(
      terminalWriteInputSchema.safeParse({
        terminalId: "t1",
        data: `${wide}\u{1F600}`,
      }).success,
    ).toBe(false);
  });
});

describe("strictness at the process boundaries", () => {
  it.each([
    ["a port request with an extra key", terminalPortRequestSchema, {
      kind: "ack",
      terminalId: "t1",
      charCount: 10,
      shellCommand: "rm -rf /",
    }],
    ["a port request with an unknown kind", terminalPortRequestSchema, {
      kind: "spawn",
      terminalId: "t1",
    }],
    ["a port event with an extra key", terminalPortEventSchema, {
      kind: "data",
      terminalId: "t1",
      data: "x",
      cwd: "/etc",
    }],
    ["a control envelope with an extra key", terminalHostEnvelopeSchema, {
      requestId: "r1",
      request: { kind: "shutdownAll" },
      privileged: true,
    }],
    ["a control request that smuggles an executable", terminalHostEnvelopeSchema, {
      requestId: "r1",
      request: { kind: "kill", terminalId: "t1", windowId: "w1", signal: "KILL" },
    }],
  ])("REJECTS %s", (_label, schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it("accepts the well-formed shapes it is meant to", () => {
    expect(
      terminalPortRequestSchema.safeParse({ kind: "attach", terminalId: "t1" }).success,
    ).toBe(true);
    expect(
      terminalHostEnvelopeSchema.safeParse({
        requestId: "r1",
        request: { kind: "kill", terminalId: "t1", windowId: "w1" },
      }).success,
    ).toBe(true);
  });

  it("rejects a snapshot whose version this build does not understand", () => {
    const parsed = terminalWorkspaceSnapshotSchema.safeParse({
      version: 99,
      projectId: "p1",
      savedAt: 0,
      layout: { projectId: "p1", groups: [], activeGroupIndex: 0 },
      terminals: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("never lets an environment ride a persisted snapshot", () => {
    // Environments carry credentials. Recomputing on restore is the contract;
    // `.strict()` is what enforces it against a future writer that forgets.
    //
    // THE ENTRY IS OTHERWISE COMPLETE AND VALID, and that is the point of the
    // control below. An earlier version of this test built an entry that was
    // also missing required fields, so it failed for reasons unrelated to
    // `env` and would have gone on passing with `.strict()` deleted - it
    // asserted nothing about the environment at all. Parsing the same entry
    // twice, differing only in the stray key, makes strictness the only thing
    // that can explain the refusal.
    const validEntry = {
      terminalId: "t1",
      title: "bash",
      shellName: "bash",
      executable: "/bin/bash",
      args: [],
      cwdAtSpawn: "/p",
      cols: 80,
      rows: 24,
      serialized: "",
      droppedRows: 0,
      reducedRows: 0,
    };
    const snapshotWith = (entry: unknown): unknown => ({
      version: 1,
      projectId: "p1",
      savedAt: 0,
      layout: { projectId: "p1", groups: [], activeGroupIndex: 0 },
      terminals: [entry],
    });

    // THE CONTROL: without the stray key this exact snapshot is accepted.
    expect(
      terminalWorkspaceSnapshotSchema.safeParse(snapshotWith(validEntry)).success,
    ).toBe(true);

    expect(
      terminalWorkspaceSnapshotSchema.safeParse(
        snapshotWith({ ...validEntry, env: { GITHUB_TOKEN: "ghp_secret" } }),
      ).success,
    ).toBe(false);
  });
});

describe("the per-terminal snapshot bound", () => {
  // `serialized` is bounded BY BYTES, not by `.length`. A chars-only bound
  // would let a scrollback of four-byte characters carry four times the
  // intended payload into the mirror on restore, and the row reduction that
  // is supposed to produce a within-bound entry would have no contract to
  // fail against.
  const wide = "\u{1F600}"; // four UTF-8 bytes, one `.length` unit is wrong here
  const atBound = "a".repeat(TERMINAL_SNAPSHOT_MAX_BYTES - 4) + wide;
  const overBound = atBound + "a";

  it("measures the entry in BYTES and not in string length", () => {
    expect(utf8ByteLength(atBound)).toBe(TERMINAL_SNAPSHOT_MAX_BYTES);
    // The multi-byte character is what makes this a byte test: the string is
    // three units SHORTER than the byte bound it exactly reaches.
    expect(atBound.length).toBeLessThan(TERMINAL_SNAPSHOT_MAX_BYTES);
  });

  it("ACCEPTS an entry exactly at TERMINAL_SNAPSHOT_MAX_BYTES", () => {
    expect(
      terminalSnapshotEntrySchema.safeParse(snapshotEntry("t1", atBound)).success,
    ).toBe(true);
  });

  it("REFUSES an entry one byte past TERMINAL_SNAPSHOT_MAX_BYTES", () => {
    expect(utf8ByteLength(overBound)).toBe(TERMINAL_SNAPSHOT_MAX_BYTES + 1);
    expect(
      terminalSnapshotEntrySchema.safeParse(snapshotEntry("t1", overBound)).success,
    ).toBe(false);
  });
});

describe("group layout invariants", () => {
  it("REFUSES a group with zero panes, whatever its activePaneIndex", () => {
    // An empty group renders as a tab with nothing in it - a state the UI
    // cannot draw and every consumer would otherwise have to re-check.
    //
    // Measured note: this is enforced TWICE over, by `panes.min(1)` and by the
    // activePaneIndex refinement (no index satisfies `i < 0`). Deleting either
    // one alone leaves the contract intact, so the assertion is written over
    // the contract - no empty group parses - rather than over one guard.
    for (const activePaneIndex of [0, 1]) {
      expect(
        terminalGroupLayoutSchema.safeParse({
          groupId: "g1",
          orientation: "horizontal",
          panes: [],
          activePaneIndex,
        }).success,
      ).toBe(false);
    }
  });

  it("ACCEPTS a group with one pane", () => {
    expect(terminalGroupLayoutSchema.safeParse(group("g1", ["t1"])).success).toBe(true);
  });

  it("REFUSES an activePaneIndex past the end of panes", () => {
    // An out-of-range active index names a pane that does not exist; the
    // renderer would dereference nothing while restoring a saved workspace.
    expect(
      terminalGroupLayoutSchema.safeParse(group("g1", ["t1", "t2"], 2)).success,
    ).toBe(false);
  });

  it("ACCEPTS the last valid activePaneIndex", () => {
    expect(
      terminalGroupLayoutSchema.safeParse(group("g1", ["t1", "t2"], 1)).success,
    ).toBe(true);
  });

  it("REFUSES the same terminalId in two panes of ONE group", () => {
    // Preload allows a single subscriber per (terminalId, event kind), so a
    // terminal named twice gives one pty two consumers and the second
    // silently steals the first's output.
    expect(
      terminalGroupLayoutSchema.safeParse(group("g1", ["t1", "t1"])).success,
    ).toBe(false);
  });
});

describe("workspace layout invariants", () => {
  it("REFUSES an activeGroupIndex past the end of groups", () => {
    // Same defect as the pane index, one level up: a restored workspace whose
    // active tab does not exist.
    const parsed = terminalWorkspaceLayoutSchema.safeParse({
      projectId: "p1",
      groups: [group("g1", ["t1"])],
      activeGroupIndex: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("ACCEPTS activeGroupIndex 0 with an EMPTY groups array", () => {
    // A project with no terminals open is legitimate, and it is the shape
    // every first save of a fresh project writes. A naive `index < length`
    // rule would refuse the ordinary case and discard the file whole.
    expect(
      terminalWorkspaceLayoutSchema.safeParse({
        projectId: "p1",
        groups: [],
        activeGroupIndex: 0,
      }).success,
    ).toBe(true);
  });

  it("REFUSES two groups sharing a groupId", () => {
    // Group ids address tabs. Two tabs with one id makes every later
    // operation - focus, close, split - ambiguous about which it acted on.
    const parsed = terminalWorkspaceLayoutSchema.safeParse({
      projectId: "p1",
      groups: [group("g1", ["t1"]), group("g1", ["t2"])],
      activeGroupIndex: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES the same terminalId in panes of TWO DIFFERENT groups", () => {
    // The workspace-wide rule, and the one a per-group check cannot catch.
    // Preload allows a single subscriber per (terminalId, event kind), so a
    // terminal named by a pane in each of two tabs gives one pty two
    // consumers and the second silently steals the first's output.
    const parsed = terminalWorkspaceLayoutSchema.safeParse({
      projectId: "p1",
      groups: [group("g1", ["t1"]), group("g2", ["t1"])],
      activeGroupIndex: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("ACCEPTS two groups naming DISTINCT terminals", () => {
    expect(
      terminalWorkspaceLayoutSchema.safeParse({
        projectId: "p1",
        groups: [group("g1", ["t1"]), group("g2", ["t2"])],
        activeGroupIndex: 1,
      }).success,
    ).toBe(true);
  });
});

describe("workspace snapshot invariants", () => {
  const layout = {
    projectId: "p1",
    groups: [group("g1", ["t1"])],
    activeGroupIndex: 0,
  };

  it("ACCEPTS a coherent snapshot", () => {
    expect(
      terminalWorkspaceSnapshotSchema.safeParse(
        workspaceSnapshot("p1", layout, [snapshotEntry("t1")]),
      ).success,
    ).toBe(true);
  });

  it("REFUSES two snapshot entries sharing a terminalId", () => {
    // Two entries for one id means two serialized mirrors for one pty, and
    // the revive would restore whichever the reader happened to see last.
    const parsed = terminalWorkspaceSnapshotSchema.safeParse(
      workspaceSnapshot("p1", layout, [snapshotEntry("t1"), snapshotEntry("t1")]),
    );
    expect(parsed.success).toBe(false);
  });

  it("REFUSES a snapshot whose layout.projectId differs from its own projectId", () => {
    // The file names one project. A layout inside it naming another describes
    // two different workspaces, and reviving it would open one project's
    // shells under another project's name.
    const parsed = terminalWorkspaceSnapshotSchema.safeParse(
      workspaceSnapshot(
        "p1",
        { projectId: "p2", groups: [group("g1", ["t1"])], activeGroupIndex: 0 },
        [snapshotEntry("t1")],
      ),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The failure is the cross-field refinement, not a field-level type
      // error: it belongs to the object as a whole.
      expect(parsed.error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("terminalSnapshotFileName is a path-traversal gate", () => {
  // Two processes resolve this name - the pty host writes and reads these
  // files, main DELETES them on project delete - so a projectId that escapes
  // the snapshot directory escapes it for a privileged deleter as well. The
  // REFUSALS are the point of this table.
  it.each([
    ["the empty string", ""],
    ["the current directory", "."],
    ["the parent directory", ".."],
    ["a nested posix path", "a/b"],
    ["a posix traversal", "../escape"],
    ["a windows separator", "a\\b"],
    ["an absolute posix path", "/etc/passwd"],
    ["a NUL byte", `a${String.fromCharCode(0)}b`],
    ["a newline", `a${String.fromCharCode(10)}b`],
    ["a leading NUL truncation attempt", `${String.fromCharCode(0)}..`],
    ["an over-64-character id", "a".repeat(65)],
    ["a space", "a b"],
    ["a tilde", "~"],
    ["a percent-encoded traversal", "%2e%2e"],
  ])("REFUSES %s", (_label, projectId) => {
    expect(terminalSnapshotFileName(projectId)).toBeNull();
  });

  it.each([
    ["a plain id", "project1"],
    ["letters and digits", "abc123"],
    ["a hyphen", "my-project"],
    ["an underscore", "my_project"],
    ["a dot inside the name", "my.project"],
    ["a single character", "a"],
    ["exactly 64 characters", "a".repeat(64)],
  ])("ACCEPTS %s", (_label, projectId) => {
    expect(terminalSnapshotFileName(projectId)).toBe(`${projectId}.json`);
  });

  it("never returns a name containing a separator", () => {
    // The whole contract in one assertion: whatever comes back can only ever
    // be a leaf inside the snapshot directory.
    const name = terminalSnapshotFileName("my-project_1.a");
    expect(name).not.toBeNull();
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
  });
});
