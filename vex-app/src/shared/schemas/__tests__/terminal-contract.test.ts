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
  TERMINAL_COMMIT_BOUND_MS,
  TERMINAL_KILL_SETTLE_MS,
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
  TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS,
  TERMINAL_PENDING_CEILING_BYTES,
  TERMINAL_PERSIST_TIMEOUT_MS,
  TERMINAL_SHUTDOWN_DISPOSE_ALLOWANCE_MS,
  TERMINAL_SNAPSHOT_COMMIT_ALLOWANCE_MS,
  TERMINAL_SNAPSHOT_DRAIN_MS,
  TERMINAL_SNAPSHOT_MAX_BYTES,
  TERMINAL_SNAPSHOT_VERSION,
  TERMINAL_WRITE_MAX_BYTES,
  WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
  ptyHostEnvironment,
  terminalGroupLayoutSchema,
  terminalHostEnvelopeSchema,
  terminalPortEventSchema,
  terminalPortRequestSchema,
  terminalCreateInputSchema,
  terminalCreateValueSchema,
  terminalDescribeResultSchema,
  terminalLaunchSchema,
  terminalPropertySchema,
  terminalWorkspaceRestoreSchema,
  terminalShellCatalogueSchema,
  terminalShellIdSchema,
  terminalShellOptionSchema,
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

/**
 * THE DEADLINES MAIN GIVES THE HOST ARE DERIVED FROM WHAT THE HOST DOES.
 *
 * They used to be the flat control-request budget, and that was a durability
 * defect rather than a tuning miss: main disposes the pty host - and KILLS the
 * child - once a request's deadline passes, so a shutdown whose real bound
 * exceeded the deadline was killed in the middle of the commit that writes the
 * user's terminals to disk. These assertions are what stop a future edit to one
 * constant from silently reopening that gap, because every term below names a
 * bound the host actually enforces.
 */
describe("shutdown and persist deadlines are composed from the host's own bounds", () => {
  it("derives ONE commit bound from the drain bound plus the commit allowance", () => {
    // The drains run CONCURRENTLY, so a project's drain phase costs one drain
    // bound however many terminals it holds. A per-terminal term here would be
    // the sequential arithmetic that produced the 24 s / 5 s mismatch.
    expect(TERMINAL_COMMIT_BOUND_MS).toBe(
      TERMINAL_SNAPSHOT_DRAIN_MS + TERMINAL_SNAPSHOT_COMMIT_ALLOWANCE_MS,
    );
  });

  it("gives a persist room for one in-flight commit AND its coalesced follow-up", () => {
    // The host serializes a project's commits and coalesces the requests that
    // arrive during one, so the worst case a CORRECT host produces is two
    // commit bounds. A deadline of one would time out the very serialization
    // that makes overlapping persists safe.
    expect(TERMINAL_PERSIST_TIMEOUT_MS).toBe(2 * TERMINAL_COMMIT_BOUND_MS);
  });

  it("sums the orderly shutdown's three phases, in the order the host runs them", () => {
    expect(TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS).toBe(
      TERMINAL_PERSIST_TIMEOUT_MS
      + TERMINAL_MAXIMUM_SHUTDOWN_MS
      + TERMINAL_SHUTDOWN_DISPOSE_ALLOWANCE_MS,
    );
  });

  it("keeps the shutdown deadline above the flat control-request budget", () => {
    // The flat budget is the value this deadline replaced. If a constant change
    // ever brings the derived figure back to or below it, the derivation has
    // stopped describing the work and the mid-commit kill is back.
    expect(TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(
      TERMINAL_CREATE_TIMEOUT_MS,
    );
    expect(TERMINAL_PERSIST_TIMEOUT_MS).toBeGreaterThan(TERMINAL_COMMIT_BOUND_MS);
  });

  it("bounds the shutdown by a figure that does NOT scale with the terminal count", () => {
    // The property the concurrency buys. Sequential drains made the real bound
    // TERMINALS_GLOBAL_MAX * TERMINAL_SNAPSHOT_DRAIN_MS before a single byte
    // was written; a deadline derived from that arithmetic would have to be
    // larger than this one, and the app would hang on quit instead.
    expect(TERMINAL_COMMIT_BOUND_MS).toBeLessThan(
      TERMINALS_GLOBAL_MAX * TERMINAL_SNAPSHOT_DRAIN_MS,
    );
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
    // The layout NAMES the entry. It used to be empty, which the schema now
    // refuses outright: an entry no pane references is the invisible-shell case
    // the referential invariant was added for. Keeping the empty layout would
    // make this test fail for a reason that has nothing to do with `env`, which
    // is precisely the confusion its own comment warns about.
    const snapshotWith = (entry: unknown): unknown => ({
      version: 1,
      projectId: "p1",
      savedAt: 0,
      layout: {
        projectId: "p1",
        activeGroupIndex: 0,
        groups: [
          {
            groupId: "g1",
            orientation: "horizontal",
            activePaneIndex: 0,
            panes: [{ terminalId: "t1", relativeSize: 1 }],
          },
        ],
      },
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


describe("a snapshot's two halves describe the SAME terminals", () => {
  /**
   * The file used to permit either half to name a terminal the other did not.
   *
   * One direction is merely wasteful - a pane with no buffer to restore. The
   * other created an INVISIBLE SHELL: an entry no pane referenced was revived
   * into a live pty that no pane could show and nothing in the UI could name in
   * order to close, so it held capacity against the per-project bound and a
   * lease against its project for the life of the session. A slow close racing
   * a persist is all it took.
   *
   * The invariant is a bijection, and it belongs in the schema for the same
   * reason the group invariants do: every consumer would otherwise have to
   * re-check it, and the one that forgot is the one that shipped.
   */
  const base = {
    version: TERMINAL_SNAPSHOT_VERSION,
    projectId: "p1",
    savedAt: 1,
  };

  function entry(terminalId: string): unknown {
    return {
      terminalId,
      title: "bash",
      shellName: "bash",
      executable: "/bin/bash",
      args: [],
      cwdAtSpawn: "/projects/p1",
      cols: 80,
      rows: 24,
      serialized: "",
      droppedRows: 0,
      reducedRows: 0,
    };
  }

  function layout(terminalIds: readonly string[]): unknown {
    return {
      projectId: "p1",
      activeGroupIndex: 0,
      groups:
        terminalIds.length === 0
          ? []
          : [
              {
                groupId: "g1",
                orientation: "horizontal",
                activePaneIndex: 0,
                panes: terminalIds.map((terminalId) => ({
                  terminalId,
                  relativeSize: 1 / terminalIds.length,
                })),
              },
            ],
    };
  }

  it("accepts a file whose panes and entries match exactly", () => {
    const parsed = terminalWorkspaceSnapshotSchema.safeParse({
      ...base,
      layout: layout(["t1", "t2"]),
      terminals: [entry("t1"), entry("t2")],
    });
    expect(parsed.success).toBe(true);
  });

  it("REFUSES a pane naming a terminal the file does not carry", () => {
    const parsed = terminalWorkspaceSnapshotSchema.safeParse({
      ...base,
      layout: layout(["t1", "ghost"]),
      terminals: [entry("t1")],
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES an entry no pane references, which is the invisible-shell case", () => {
    const parsed = terminalWorkspaceSnapshotSchema.safeParse({
      ...base,
      layout: layout(["t1"]),
      terminals: [entry("t1"), entry("orphan")],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * THE DISPLAY-ONLY CONTRACT.
 *
 * The property under test is a NEGATIVE one and it is the point of the whole
 * change: no schema that reaches the renderer has a field for a filesystem
 * path. These assertions go red the moment someone re-adds one, which is the
 * only way a raw path can get back onto the wire.
 */
describe("no renderer-facing terminal schema carries a raw path", () => {
  it("the property union has displayCwd and no longer has cwd", () => {
    expect(
      terminalPropertySchema.safeParse({ property: "displayCwd", value: "src/lib" })
        .success,
    ).toBe(true);
    expect(
      terminalPropertySchema.safeParse({ property: "cwd", value: "/home/ada/p" })
        .success,
    ).toBe(false);
  });

  it("a create value is refused when it carries cwd instead of displayCwd", () => {
    const base = { terminalId: "t1", pid: 4, shellName: "bash" };
    expect(
      terminalCreateValueSchema.safeParse({ ...base, displayCwd: "vex-core" }).success,
    ).toBe(true);
    // `.strict()` is what makes this a refusal rather than a silently dropped
    // field, which is the difference between a contract and a convention.
    expect(
      terminalCreateValueSchema.safeParse({ ...base, cwd: "/home/ada/p" }).success,
    ).toBe(false);
  });

  it("a restore row carries the reattach seed, and NULL is a legal answer", () => {
    const row = {
      terminalId: "t1",
      title: "vim",
      shellName: "bash",
      droppedRows: 0,
      reducedRows: 0,
    };
    const restore = (displayCwd: unknown): unknown => ({
      layout: { projectId: "p1", groups: [], activeGroupIndex: 0 },
      terminals: [{ ...row, displayCwd }],
      idMap: [],
    });

    expect(terminalWorkspaceRestoreSchema.safeParse(restore("vex-app/src")).success).toBe(
      true,
    );
    // THE HONEST UNKNOWN. A reattach main could not seed says so, rather than
    // omitting the field and leaving each reader to invent a default.
    expect(terminalWorkspaceRestoreSchema.safeParse(restore(null)).success).toBe(true);
    // REQUIRED, so a producer cannot forget it.
    expect(
      terminalWorkspaceRestoreSchema.safeParse({
        layout: { projectId: "p1", groups: [], activeGroupIndex: 0 },
        terminals: [row],
        idMap: [],
      }).success,
    ).toBe(false);
    // The same 4096 bound as the property that supersedes it: one contract for
    // one value, so a seed can never carry more than a later change can.
    expect(terminalWorkspaceRestoreSchema.safeParse(restore("a".repeat(4096))).success)
      .toBe(true);
    expect(terminalWorkspaceRestoreSchema.safeParse(restore("a".repeat(4097))).success)
      .toBe(false);
    // And still no raw path field, which is what this whole block is about.
    expect(
      terminalWorkspaceRestoreSchema.safeParse({
        layout: { projectId: "p1", groups: [], activeGroupIndex: 0 },
        terminals: [{ ...row, displayCwd: null, cwd: "/home/ada/p" }],
        idMap: [],
      }).success,
    ).toBe(false);
  });

  it("a describe answer is a LABEL per terminal, bounded and never nullable", () => {
    expect(
      terminalDescribeResultSchema.safeParse({
        terminals: [{ terminalId: "t1", displayCwd: "vex-app/src" }],
      }).success,
    ).toBe(true);
    // An id the host does not hold is OMITTED from the array. It is never
    // reported as a null label, because "the host has no such terminal" and
    // "the host cannot name this terminal's directory" are different facts and
    // only main is entitled to collapse them into the restore row's `null`.
    expect(
      terminalDescribeResultSchema.safeParse({
        terminals: [{ terminalId: "t1", displayCwd: null }],
      }).success,
    ).toBe(false);
    expect(
      terminalDescribeResultSchema.safeParse({
        terminals: [{ terminalId: "t1", displayCwd: "a".repeat(4097) }],
      }).success,
    ).toBe(false);
    // The request side is bounded by the same per-project ceiling the answer is,
    // so no single describe can ask about more terminals than can exist.
    expect(
      terminalHostEnvelopeSchema.safeParse({
        requestId: "r1",
        request: {
          kind: "describeTerminals",
          terminalIds: Array.from(
            { length: TERMINALS_PER_PROJECT_MAX + 1 },
            (_unused, index) => `t${String(index)}`,
          ),
        },
      }).success,
    ).toBe(false);
  });

  it("a launch REQUIRES the project label main derives the display value from", () => {
    const launch = {
      executable: "/bin/bash",
      args: [],
      cwd: "/home/ada/Vex/projects/vex-core",
      cols: 80,
      rows: 24,
      env: {},
    };
    expect(terminalLaunchSchema.safeParse(launch).success).toBe(false);
    expect(
      terminalLaunchSchema.safeParse({ ...launch, projectLabel: "vex-core" }).success,
    ).toBe(true);
  });
});

/**
 * THE SHELL CATALOGUE IS A CLOSED SET, and the wire says so.
 *
 * A table over the enum rather than three hand-picked cases: the security
 * property is that NOTHING outside the enum parses, and only enumerating it
 * proves that as the set grows.
 */
describe("the shell catalogue is an enumerated contract", () => {
  it("accepts every member of the enum as a create input", () => {
    for (const shellId of terminalShellIdSchema.options) {
      const parsed = terminalCreateInputSchema.safeParse({
        projectId: "p1",
        shellId,
        cols: 80,
        rows: 24,
      });
      expect(parsed.success, shellId).toBe(true);
    }
  });

  it("REFUSES anything that is not a member, including a path", () => {
    for (const shellId of [
      "/bin/bash",
      "../../bin/sh",
      "bash;rm -rf /",
      "BASH",
      "",
      null,
      42,
    ]) {
      const parsed = terminalCreateInputSchema.safeParse({
        projectId: "p1",
        shellId,
        cols: 80,
        rows: 24,
      });
      expect(parsed.success, String(shellId)).toBe(false);
    }
  });

  it("REFUSES a create input with no shell at all, so the default has one owner", () => {
    expect(
      terminalCreateInputSchema.safeParse({ projectId: "p1", cols: 80, rows: 24 })
        .success,
    ).toBe(false);
  });

  it("a catalogue row carries no path, and one that smuggles a path is refused", () => {
    const row = { id: "bash", label: "bash", available: true };
    expect(terminalShellOptionSchema.safeParse(row).success).toBe(true);
    expect(
      terminalShellOptionSchema.safeParse({ ...row, path: "/bin/bash" }).success,
    ).toBe(false);
  });

  it("a catalogue names its default, and the default must be a known shell", () => {
    const shells = [{ id: "bash", label: "bash", available: true }];
    expect(
      terminalShellCatalogueSchema.safeParse({ shells, defaultShellId: "bash" }).success,
    ).toBe(true);
    expect(
      terminalShellCatalogueSchema.safeParse({ shells, defaultShellId: "nu" }).success,
    ).toBe(false);
    expect(terminalShellCatalogueSchema.safeParse({ shells }).success).toBe(false);
  });
});

/**
 * THE REVIVE REQUEST'S ENVIRONMENT OVERLAY, and the compatibility it promises.
 *
 * A restored terminal is a NEW shell: the old process is gone and only its
 * scrollback survived. It therefore needs the same overlay a create carries,
 * and the snapshot deliberately holds none (see "never lets an environment
 * ride a persisted snapshot" above), so the only place it can come from is the
 * request. Before this field a revive sent nothing and the host launched every
 * restored shell from the bare scrubbed base - which has `VEX_*` stripped.
 *
 * The field is EXPAND-ONLY, which is the half a schema test can prove and a
 * behaviour test cannot: a request minted by a main that predates it still
 * parses, so a reader can ship ahead of its writer.
 */
describe("a revive carries the environment overlay a create carries", () => {
  const revive = (extra: Record<string, unknown>): unknown => ({
    requestId: "r1",
    request: {
      kind: "revive",
      projectId: "p1",
      windowId: "w1",
      projectLabel: "proj",
      assignments: [{ from: "t1", to: "t2" }],
      ...extra,
    },
  });

  it("accepts an overlay, and hands it through as the record it was given", () => {
    const parsed = terminalHostEnvelopeSchema.safeParse(
      revive({ env: { VEX_CONFIG_DIR: "/home/u/.config/vex-alt", STALE: null } }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.request.kind !== "revive") throw new Error("wrong branch");
    expect(parsed.data.request.env).toEqual({
      VEX_CONFIG_DIR: "/home/u/.config/vex-alt",
      STALE: null,
    });
  });

  it("still accepts a request that carries NO overlay, and reports its absence", () => {
    // The compatibility claim, asserted rather than assumed. `undefined` is
    // what the host resolves to the empty overlay at its boundary, which is
    // the behaviour that shipped before the field existed.
    const parsed = terminalHostEnvelopeSchema.safeParse(revive({}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.request.kind !== "revive") throw new Error("wrong branch");
    expect(parsed.data.request.env).toBeUndefined();
  });

  it("refuses an overlay value that is neither a string nor a delete", () => {
    // The overlay's three outcomes are set, delete and leave alone. A number
    // is a fourth thing the composer has no meaning for, and it reaches the
    // host across a process boundary.
    expect(terminalHostEnvelopeSchema.safeParse(revive({ env: { A: 7 } })).success)
      .toBe(false);
  });
});
