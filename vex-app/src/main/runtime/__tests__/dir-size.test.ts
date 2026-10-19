/**
 * The bounded size walk behind Settings' "Data size": real files in a
 * temporary directory, plus a stand-in filesystem for the failure modes.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measureDirectory, type DirSizeEntry, type DirSizeStat } from "../native/dir-size.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "vex-dir-size-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("measureDirectory", () => {
  it("adds up every regular file, however deep", async () => {
    mkdirSync(path.join(root, "base", "16384"), { recursive: true });
    writeFileSync(path.join(root, "PG_VERSION"), "18\n");
    writeFileSync(path.join(root, "base", "16384", "1259"), Buffer.alloc(8192));
    writeFileSync(path.join(root, "base", "16384", "1259_fsm"), Buffer.alloc(24_576));
    expect(await measureDirectory(root)).toEqual({ bytes: 3 + 8192 + 24_576, files: 3, complete: true });
  });

  it("counts a link as itself and never follows it out of the directory", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "vex-dir-size-outside-"));
    try {
      writeFileSync(path.join(outside, "big"), Buffer.alloc(1_000_000));
      symlinkSync(outside, path.join(root, "link"), "dir");
      writeFileSync(path.join(root, "own"), "abc");
      expect(await measureDirectory(root)).toEqual({ bytes: 3, files: 1, complete: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("answers nothing, completely, for a directory that does not exist", async () => {
    expect(await measureDirectory(path.join(root, "missing"))).toEqual({ bytes: 0, files: 0, complete: true });
  });

  it("stops at its entry bound and says the answer is a lower bound", async () => {
    for (let i = 0; i < 10; i++) writeFileSync(path.join(root, `f${String(i)}`), "x");
    expect(await measureDirectory(root, { maxEntries: 4 })).toEqual({ bytes: 4, files: 4, complete: false });
    expect(await measureDirectory(root, { maxEntries: 10 })).toEqual({ bytes: 10, files: 10, complete: true });
  });

  it("skips what vanishes mid-walk, but marks what it could not read", async () => {
    const dirent = (name: string): DirSizeEntry => ({ name });
    const file = (size: number): DirSizeStat => ({ isDirectory: () => false, isFile: () => true, size });
    const folder: DirSizeStat = { isDirectory: () => true, isFile: () => false, size: 0 };
    const errno = (code: string): Error => Object.assign(new Error(code), { code });
    const result = await measureDirectory("/data", {
      fs: {
        readdir: async (dir) => {
          if (dir === "/data") return [dirent("a"), dirent("gone"), dirent("locked")];
          throw errno("EACCES");
        },
        lstat: async (full) => {
          if (full.endsWith("gone")) throw errno("ENOENT");
          return full.endsWith("locked") ? folder : file(5);
        },
      },
    });
    expect(result).toEqual({ bytes: 5, files: 1, complete: false });
  });
});
