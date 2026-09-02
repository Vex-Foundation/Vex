/**
 * THE NO-FOLLOW OPEN, DRIVEN THROUGH A SCRIPTED FILESYSTEM.
 *
 * Every property this module owns is a RACE: a link that appears between the
 * `lstat` and the `open`, a file replaced between the `open` and the check, an
 * identity a platform cannot supply. None of them can be produced on demand
 * against a real disk, and a test that slept and hoped would be a flake with a
 * name. So the filesystem is the injected `NoFollowFs` seam and the fake
 * ANSWERS those races on cue.
 *
 * The real-filesystem side is not abandoned: `files-real-fs.test.ts` drives the
 * standing-link cases (a symlinked `.gitignore`, a symlinked file in the tree)
 * against real `symlink` calls on all three platforms. This file covers what
 * that one cannot reach.
 *
 * Adopted from VS Code's `pfs.test.ts` (`src/vs/base/test/node/pfs/pfs.test.ts`,
 * the `stat link` cases): its symlink tests run against real temp directories
 * and guard ONLY the assertions the platform cannot support. Rejected from it:
 * the shape where every symlink case is a real-disk case, because the
 * post-open replacement window has no real-disk equivalent that is
 * deterministic.
 */

import type { BigIntStats } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../logger/index.js", () => ({
  log: {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    silly: () => undefined,
  },
}));

import { readTextFileBounded } from "../bounded-read.js";
import { IGNORE_FILE_MAX_BYTES } from "../excludes.js";
import {
  type NoFollowFs,
  type NoFollowHandle,
  openWithoutFollowing,
} from "../no-follow-open.js";
import { readFileForViewer } from "../read.js";

const PATH = "/projects/demo/.gitignore";

/** What a scripted `lstat` or `fstat` answers. */
interface FakeStat {
  readonly kind: "file" | "symlink" | "fifo";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size?: bigint;
}

function stats(fake: FakeStat): BigIntStats {
  return {
    dev: fake.dev,
    ino: fake.ino,
    size: fake.size ?? 0n,
    mtimeMs: 1_700_000_000_000n,
    isFile: () => fake.kind === "file",
    isSymbolicLink: () => fake.kind === "symlink",
    isDirectory: () => false,
  } as unknown as BigIntStats;
}

/**
 * Two DIFFERENT files whose inode numbers are indistinguishable as JavaScript
 * numbers: 2^53 and 2^53 + 1 both become 9007199254740992 as doubles. Windows
 * file IDs are 64-bit, so this collision is the reason both stats are taken
 * with `{ bigint: true }` and compared as bigints.
 */
const REGULAR: FakeStat = { kind: "file", dev: 66n, ino: 9_007_199_254_740_992n };
const REPLACEMENT: FakeStat = { kind: "file", dev: 66n, ino: 9_007_199_254_740_993n };

/**
 * A filesystem that answers on cue, and records the order it was asked.
 *
 * `lstats` is consumed one answer per call, so "regular, then a link" is a
 * literal script of the replacement window. `calls` is what proves no byte was
 * read before the identity was established.
 */
function scriptedFs(script: {
  readonly lstats: readonly (FakeStat | Error)[];
  readonly fstat: FakeStat | Error;
  readonly openError?: Error;
  readonly bytes?: string;
}): {
  readonly fs: NoFollowFs;
  readonly calls: string[];
  readonly closed: () => number;
} {
  const calls: string[] = [];
  let closes = 0;
  let lstatIndex = 0;
  const payload = Buffer.from(script.bytes ?? "", "utf8");

  const handle: NoFollowHandle = {
    stat: async () => {
      calls.push("fstat");
      if (script.fstat instanceof Error) throw script.fstat;
      return stats(script.fstat);
    },
    read: async (buffer, offset, length, position) => {
      calls.push("read");
      if (position >= payload.length) return { bytesRead: 0 };
      const bytesRead = payload.copy(
        buffer,
        offset,
        position,
        Math.min(payload.length, position + length),
      );
      return { bytesRead };
    },
    close: async () => {
      calls.push("close");
      closes += 1;
    },
  };

  return {
    calls,
    closed: () => closes,
    fs: {
      lstat: async () => {
        calls.push("lstat");
        const answer = script.lstats[lstatIndex] ?? script.lstats.at(-1);
        lstatIndex += 1;
        if (answer === undefined) throw new Error("the script ran out of lstats");
        if (answer instanceof Error) throw answer;
        return stats(answer);
      },
      open: async () => {
        calls.push("open");
        if (script.openError !== undefined) throw script.openError;
        return handle;
      },
    },
  };
}

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("openWithoutFollowing", () => {
  it("REFUSES a standing symlink BEFORE it opens anything", async () => {
    // The measured Windows exploit: the ignore reader used to open first and
    // ask afterwards, and on win32 there is no `O_NOFOLLOW` to make the open
    // fail. The pre-open `lstat` is what closes it, so the assertion is that
    // `open` was never reached at all.
    const scripted = scriptedFs({
      lstats: [{ kind: "symlink", dev: 66n, ino: 9n }],
      fstat: REGULAR,
    });

    const opened = await openWithoutFollowing(PATH, scripted.fs);

    expect(opened).toEqual({ ok: false, reason: "symlinked_path" });
    expect(scripted.calls).toEqual(["lstat"]);
  });

  it("REFUSES a path that is not a regular file before opening it", async () => {
    const scripted = scriptedFs({
      lstats: [{ kind: "fifo", dev: 66n, ino: 9n }],
      fstat: REGULAR,
    });

    const opened = await openWithoutFollowing(PATH, scripted.fs);

    expect(opened).toEqual({ ok: false, reason: "not_a_file" });
    expect(scripted.calls).toEqual(["lstat"]);
  });

  it("reads NOTHING until both the handle and the path have been stated", async () => {
    const scripted = scriptedFs({
      lstats: [REGULAR, REGULAR],
      fstat: REGULAR,
      bytes: "node_modules\n",
    });

    const read = await readTextFileBounded(PATH, IGNORE_FILE_MAX_BYTES, scripted.fs);

    expect(read).toEqual({ kind: "text", text: "node_modules\n" });
    const firstRead = scripted.calls.indexOf("read");
    expect(firstRead).toBeGreaterThan(-1);
    // Both proofs are complete before the first byte moves.
    expect(scripted.calls.indexOf("fstat")).toBeLessThan(firstRead);
    expect(scripted.calls.lastIndexOf("lstat")).toBeLessThan(firstRead);
    expect(scripted.calls.at(-1)).toBe("close");
  });

  it("REFUSES a link swapped in between the open and the check, and closes", async () => {
    // The window `O_NOFOLLOW` covers on POSIX and nothing covers on Windows:
    // the open landed on the link's target, and the post-open `lstat` is the
    // only thing that can say so.
    const scripted = scriptedFs({
      lstats: [REGULAR, { kind: "symlink", dev: 70n, ino: 12n }],
      fstat: REGULAR,
      bytes: "secret\n",
    });

    const opened = await openWithoutFollowing(PATH, scripted.fs);

    expect(opened).toEqual({ ok: false, reason: "symlinked_path" });
    expect(scripted.calls).not.toContain("read");
    expect(scripted.closed()).toBe(1);
  });

  it("REFUSES a file replaced by ANOTHER FILE, and does not call it a symlink", async () => {
    // A regular file swapped for a regular file is not a link, and reporting
    // one would be evidence nobody collected.
    const scripted = scriptedFs({
      lstats: [REGULAR, REPLACEMENT],
      fstat: REGULAR,
      bytes: "secret\n",
    });

    const opened = await openWithoutFollowing(PATH, scripted.fs);

    expect(opened).toEqual({ ok: false, reason: "path_changed" });
    expect(scripted.calls).not.toContain("read");
    expect(scripted.closed()).toBe(1);
  });

  it("compares identity as BIGINT, so two files past 2^53 are not the same file", () => {
    // The reason both stats are taken with `{ bigint: true }`: Windows file IDs
    // are 64-bit, and these two collide the moment they become numbers.
    expect(Number(REGULAR.ino)).toBe(Number(REPLACEMENT.ino));
    expect(REGULAR.ino).not.toBe(REPLACEMENT.ino);
    expect(REGULAR.ino >= 2n ** 53n).toBe(true);
  });

  it("REFUSES when the platform reports no identity at all, and closes", async () => {
    const nothing: FakeStat = { kind: "file", dev: 0n, ino: 0n };
    const onHandle = scriptedFs({ lstats: [REGULAR, REGULAR], fstat: nothing });
    expect(await openWithoutFollowing(PATH, onHandle.fs)).toEqual({
      ok: false,
      reason: "io_error",
    });
    expect(onHandle.closed()).toBe(1);
    expect(onHandle.calls).not.toContain("read");

    const onPath = scriptedFs({ lstats: [REGULAR, nothing], fstat: REGULAR });
    expect(await openWithoutFollowing(PATH, onPath.fs)).toEqual({
      ok: false,
      reason: "io_error",
    });
    expect(onPath.closed()).toBe(1);
    expect(onPath.calls).not.toContain("read");
  });

  it("REFUSES when the path vanished between the open and the check", async () => {
    const scripted = scriptedFs({
      lstats: [REGULAR, fsError("ENOENT")],
      fstat: REGULAR,
    });

    const opened = await openWithoutFollowing(PATH, scripted.fs);

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("path_changed");
    expect(scripted.closed()).toBe(1);
    expect(scripted.calls).not.toContain("read");
  });

  it("maps an ELOOP open to a symlink, and an absent path to not_found", async () => {
    const looped = scriptedFs({
      lstats: [REGULAR],
      fstat: REGULAR,
      openError: fsError("ELOOP"),
    });
    const loopedOpen = await openWithoutFollowing(PATH, looped.fs);
    expect(loopedOpen.ok).toBe(false);
    if (!loopedOpen.ok) expect(loopedOpen.reason).toBe("symlinked_path");

    const gone = scriptedFs({ lstats: [fsError("ENOENT")], fstat: REGULAR });
    const goneOpen = await openWithoutFollowing(PATH, gone.fs);
    expect(goneOpen.ok).toBe(false);
    if (!goneOpen.ok) expect(goneOpen.reason).toBe("not_found");
    expect(gone.calls).toEqual(["lstat"]);
  });

  it("HANDS BACK the handle and the proving stats on an ordinary file", async () => {
    const scripted = scriptedFs({
      lstats: [REGULAR, REGULAR],
      fstat: { ...REGULAR, size: 13n },
      bytes: "node_modules\n",
    });

    const opened = await openWithoutFollowing(PATH, scripted.fs);

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.stats.ino).toBe(REGULAR.ino);
    // The caller owns the handle from here: nothing was closed for it.
    expect(scripted.closed()).toBe(0);
    await opened.handle.close();
  });
});

describe("the readers over that open", () => {
  it("gives the VIEWER `path_changed` for a replacement, not a symlink", async () => {
    const scripted = scriptedFs({
      lstats: [REGULAR, REPLACEMENT],
      fstat: REGULAR,
      bytes: "secret\n",
    });

    const read = await readFileForViewer(
      { nodeId: "id:a", relativePath: "a.txt", absolutePath: PATH },
      scripted.fs,
    );

    expect(read).toEqual({ ok: false, code: "path_changed" });
    expect(scripted.calls).not.toContain("read");
    expect(scripted.closed()).toBe(1);
  });

  it("gives the VIEWER `symlinked_path` for a link swapped in after the open", async () => {
    const scripted = scriptedFs({
      lstats: [REGULAR, { kind: "symlink", dev: 70n, ino: 12n }],
      fstat: REGULAR,
      bytes: "secret\n",
    });

    const read = await readFileForViewer(
      { nodeId: "id:a", relativePath: "a.txt", absolutePath: PATH },
      scripted.fs,
    );

    expect(read).toEqual({ ok: false, code: "symlinked_path" });
    expect(scripted.calls).not.toContain("read");
  });

  it("reads an ordinary file end to end, with the bytes and the proven size", async () => {
    const scripted = scriptedFs({
      lstats: [REGULAR, REGULAR],
      fstat: { ...REGULAR, size: 5n },
      bytes: "hello",
    });

    const read = await readFileForViewer(
      { nodeId: "id:a", relativePath: "a.txt", absolutePath: PATH },
      scripted.fs,
    );

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.text).toBe("hello");
    expect(read.value.size).toBe(5);
    expect(read.value.modifiedMs).toBe(1_700_000_000_000);
  });

  it("tells the IGNORE reader a replacement is `changed`, never `absent`", async () => {
    // `absent` would say the rule set does not exist. It did, and it was
    // swapped; the caller logs that rather than pretending nothing was there.
    const scripted = scriptedFs({
      lstats: [REGULAR, REPLACEMENT],
      fstat: REGULAR,
      bytes: "hidden.ts\n",
    });

    const read = await readTextFileBounded(PATH, IGNORE_FILE_MAX_BYTES, scripted.fs);

    expect(read).toEqual({ kind: "changed" });
    expect(scripted.calls).not.toContain("read");
  });

  it("tells the IGNORE reader a link is `absent`, which is the safe answer", async () => {
    const scripted = scriptedFs({
      lstats: [{ kind: "symlink", dev: 66n, ino: 9n }],
      fstat: REGULAR,
    });

    expect(await readTextFileBounded(PATH, IGNORE_FILE_MAX_BYTES, scripted.fs)).toEqual({
      kind: "absent",
    });
  });
});
