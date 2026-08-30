/**
 * REVIVE SNAPSHOTS on a real filesystem.
 *
 * A real temporary directory rather than a mock, because three of the things
 * being asserted are properties of the filesystem and not of this code: the
 * permission bits, the atomicity of a rename, and the absence of a leftover
 * temporary file. A mocked `fs` would happily agree with an implementation that
 * wrote a world-readable file.
 *
 * The permission assertions are skipped on Windows, where the POSIX mode bits
 * `stat` reports are not the access control the OS actually applies.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TERMINAL_SNAPSHOT_VERSION,
  type TerminalWorkspaceSnapshot,
} from "@shared/schemas/terminal.js";
import { TerminalSnapshotStore } from "../snapshot-store.js";

const posix = process.platform !== "win32";

let directory: string;
let store: TerminalSnapshotStore;

function snapshot(projectId: string, serialized = "hello"): TerminalWorkspaceSnapshot {
  return {
    version: TERMINAL_SNAPSHOT_VERSION,
    projectId,
    savedAt: 1_700_000_000_000,
    layout: {
      projectId,
      groups: [
        {
          groupId: "g1",
          orientation: "horizontal",
          panes: [{ terminalId: "t1", relativeSize: 1 }],
          activePaneIndex: 0,
        },
      ],
      activeGroupIndex: 0,
    },
    terminals: [
      {
        terminalId: "t1",
        title: "bash",
        shellName: "bash",
        executable: "/bin/bash",
        args: [],
        cwdAtSpawn: "/projects/demo",
        cols: 80,
        rows: 24,
        serialized,
        droppedRows: 3,
        reducedRows: 0,
      },
    ],
  };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vex-snapshots-"));
  store = new TerminalSnapshotStore(directory);
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("TerminalSnapshotStore", () => {
  it("writes 0600 into a 0700 directory and leaves NO temporary file behind", async () => {
    const written = await store.write(snapshot("p1"));
    expect(written.kind).toBe("ok");

    const entries = await fs.readdir(directory);
    // The rename is what makes the write atomic; a leftover `.tmp` means a
    // path that copied instead of renaming.
    expect(entries).toEqual(["p1.json"]);

    if (posix) {
      const fileMode = (await fs.stat(path.join(directory, "p1.json"))).mode & 0o777;
      const dirMode = (await fs.stat(directory)).mode & 0o777;
      // A terminal snapshot is everything that scrolled through a developer's
      // shell. World-readable is not an acceptable default for it.
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    }
  });

  it("round-trips a snapshot, dropped-row accounting included", async () => {
    await store.write(snapshot("p1"));
    const read = await store.read("p1");

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("unreachable");
    expect(read.snapshot.terminals[0]?.droppedRows).toBe(3);
    expect(read.snapshot.layout.groups[0]?.panes[0]?.terminalId).toBe("t1");
  });

  it("reports ABSENT rather than failing for a project that has no snapshot", async () => {
    expect((await store.read("never-saved")).kind).toBe("absent");
  });

  it("DISCARDS a corrupt file WHOLE and removes it", async () => {
    await store.write(snapshot("p1"));
    await fs.writeFile(path.join(directory, "p1.json"), "{ not json", "utf8");

    const read = await store.read("p1");

    expect(read).toEqual({ kind: "discarded", reason: "corrupt" });
    // Removed, so the next launch does not rediscover the same broken file and
    // report the same notice forever.
    await expect(fs.stat(path.join(directory, "p1.json"))).rejects.toThrow();
  });

  it("DISCARDS a version mismatch as its OWN reason", async () => {
    await fs.writeFile(
      path.join(directory, "p1.json"),
      JSON.stringify({ ...snapshot("p1"), version: 99 }),
      "utf8",
    );

    // Separate from "corrupt" because upgrading Vex is an expected cause and
    // arbitrary corruption is not; an operator has to be able to tell them apart.
    expect(await store.read("p1")).toEqual({ kind: "discarded", reason: "version" });
  });

  it("refuses a project id that could escape the directory", async () => {
    expect(await store.write(snapshot("../../etc/passwd"))).toEqual({ kind: "failed" });
    expect(await store.read("../../etc/passwd")).toEqual({ kind: "absent" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("evicts the OLDEST INACTIVE project and never an active one", async () => {
    // Three projects, all far over a tiny bound, with distinct mtimes.
    for (const [index, id] of ["old", "middle", "active"].entries()) {
      await store.write(snapshot(id, "x".repeat(1024)));
      const file = path.join(directory, `${id}.json`);
      const when = new Date(1_700_000_000_000 + index * 60_000);
      await fs.utimes(file, when, when);
    }

    // A bound one byte under the current total needs EXACTLY one eviction, so
    // the assertion is about which file goes rather than about how many.
    let total = 0;
    for (const entry of await fs.readdir(directory)) {
      total += (await fs.stat(path.join(directory, entry))).size;
    }
    const evicted = await store.enforceDirectoryBound(new Set(["active"]), total - 1);

    expect(evicted).toEqual(["old"]);
    // The active project's snapshot is the state this session is about to save;
    // evicting it would delete exactly what the bound exists to protect.
    expect((await fs.readdir(directory)).sort()).toEqual(["active.json", "middle.json"]);
  });

  it("reports an empty eviction list when the directory is under its bound", async () => {
    await store.write(snapshot("p1"));
    expect(await store.enforceDirectoryBound(new Set())).toEqual([]);
  });
});
