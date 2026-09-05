/**
 * THE RENAME CONTENTION POLICY of `replaceConfinedFile` (B3).
 *
 * WHAT IS FAKED AND WHY. Everything in this suite is a real temporary
 * directory, real bytes, a real digest and a real temp file. The ONE thing
 * faked is `rename`, because the behaviour under test is a WINDOWS sharing
 * violation: a file another process holds open cannot be renamed over, and
 * libuv surfaces that as `EPERM` (or `EACCES`/`EBUSY`). There is no way to
 * stage that failure on the Linux runner that must also prove this policy, and
 * a test that only ran on the win32 lane would leave the retry loop unproven on
 * two of the three shipped platforms.
 *
 * MEASURED vs ASSERTED, stated honestly: the ERRNO MAPPING is asserted from
 * Microsoft's documented sharing-violation behaviour and libuv's translation of
 * it, not measured on a real Windows box holding a real handle. What IS proven
 * here, on every platform, is our own policy: which errnos retry, how many
 * attempts happen, that the confinement chain is re-proved before EVERY
 * attempt, that exhaustion produces the NAMED `file_locked` refusal, and that
 * the file on disk is untouched when the write is refused.
 */

import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: mocks.rename };
});

const { replaceConfinedFile, hashText } = await import("../installer/confined-fs.js");
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const LABEL = ".mcp.json";
const OLD_TEXT = '{"mcpServers":{}}\n';
const NEW_TEXT = '{"mcpServers":{"vex":{}}}\n';

let project: string;
let target: string;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rename ${code}`), { code });
}

beforeEach(async () => {
  vi.clearAllMocks();
  project = await realpath(await mkdtemp(path.join(tmpdir(), "vex-rename-")));
  target = path.join(project, LABEL);
  await writeFile(target, OLD_TEXT, "utf8");
});

async function replace(): Promise<
  Awaited<ReturnType<typeof replaceConfinedFile>>
> {
  return replaceConfinedFile({
    projectDirectory: project,
    absolutePath: target,
    relativeLabel: LABEL,
    text: NEW_TEXT,
    expectedHash: hashText(OLD_TEXT),
    mode: null,
  });
}

describe("rename contention", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "retries %s and succeeds when the holder lets go",
    async (code) => {
      let attempts = 0;
      mocks.rename.mockImplementation(async (from: string, to: string) => {
        attempts += 1;
        // Two refusals, then the real rename: the exact shape of an antivirus
        // scanner or an editor closing its handle a few milliseconds later.
        if (attempts <= 2) throw errno(code);
        await actualFs.rename(from, to);
      });

      const write = await replace();
      expect(write.kind).toBe("written");
      expect(attempts).toBe(3);
      // The world, not the self-report: the new bytes are actually on disk.
      expect(await readFile(target, "utf8")).toBe(NEW_TEXT);
    },
  );

  it("refuses with the NAMED file_locked reason after the budget, leaving the file untouched", async () => {
    mocks.rename.mockRejectedValue(errno("EPERM"));

    const write = await replace();
    expect(write.kind).toBe("refused");
    if (write.kind !== "refused") return;
    expect(write.reason).toBe("file_locked");
    // The refusal must name the class of program to close. "Check the folder's
    // permissions" was the old text and is not an action on a locked file.
    expect(write.detail).toMatch(/holding it open|editor|antivirus/i);
    // Four attempts: the first plus the three documented retries.
    expect(mocks.rename).toHaveBeenCalledTimes(4);
    expect(await readFile(target, "utf8")).toBe(OLD_TEXT);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it("does NOT retry an errno outside the policy, and reports it as a plain io_error", async () => {
    // EXDEV is a permanent structural failure (a cross-device rename). Retrying
    // it would waste the user's time and prove nothing.
    mocks.rename.mockRejectedValue(errno("EXDEV"));

    const write = await replace();
    expect(write.kind).toBe("refused");
    if (write.kind !== "refused") return;
    expect(write.reason).toBe("io_error");
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(await readFile(target, "utf8")).toBe(OLD_TEXT);
  });

  it("re-proves the parent chain before EVERY attempt, not once before the first", async () => {
    // THE PROPERTY THAT MATTERS. A retry that reused the first attempt's proof
    // would rename against a chain last checked ~150ms ago, which is precisely
    // the window `captureDirectoryChain`/`verifyDirectoryChain` exists to
    // close. Here the artifact's own directory is swapped for a symlink to a
    // directory OUTSIDE the project between the first and second attempts; the
    // retry must refuse rather than rename into it.
    const nested = path.join(project, "nested");
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "vex-rename-out-")));
    await actualFs.mkdir(nested);
    const nestedTarget = path.join(nested, LABEL);
    await writeFile(nestedTarget, OLD_TEXT, "utf8");

    let attempts = 0;
    mocks.rename.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        // The swap happens while Vex is waiting out its backoff.
        await actualFs.rm(nested, { recursive: true, force: true });
        await actualFs.symlink(outside, nested, "dir");
        throw errno("EPERM");
      }
      throw new Error("the second attempt must never reach rename");
    });

    const write = await replaceConfinedFile({
      projectDirectory: project,
      absolutePath: nestedTarget,
      relativeLabel: `nested/${LABEL}`,
      text: NEW_TEXT,
      expectedHash: hashText(OLD_TEXT),
      mode: null,
    });

    expect(write.kind).toBe("refused");
    if (write.kind !== "refused") return;
    expect(write.reason).toBe("symlinked_path");
    expect(attempts).toBe(1);
    // Nothing was written through the link.
    expect(await actualFs.readdir(outside)).toEqual([]);
  });
});
