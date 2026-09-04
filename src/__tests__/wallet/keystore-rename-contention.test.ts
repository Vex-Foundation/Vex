/**
 * `saveKeystoreFile` under RENAME CONTENTION (B3, cross-platform path
 * semantics).
 *
 * The keystore is written to a temp file and renamed into place. On Windows a
 * file another process holds open without `FILE_SHARE_DELETE` cannot be renamed
 * over: the call fails with a sharing violation, which libuv surfaces as
 * `EPERM` (sometimes `EACCES` or `EBUSY`). Backup agents, file-syncing clients
 * and antivirus scanners all open files in the Vex config directory, and all of
 * them let go within milliseconds - so a single attempt turned a transient
 * condition into a failed wallet import whose error told the user nothing.
 *
 * WHAT IS FAKED AND WHY: `renameSync` alone. The bytes, the temp file, the
 * config directory and the cleanup are real. The sharing violation cannot be
 * staged on the Linux runner that must also prove this policy, and a test that
 * only ran on a Windows lane would leave the retry unproven everywhere else.
 *
 * MEASURED vs ASSERTED: the errno-to-Windows-behaviour mapping is asserted from
 * Microsoft's documented sharing-violation semantics, not measured against a
 * real open handle. Our own policy - which errnos retry, how many attempts,
 * what the refusal says, and that the previous keystore survives - is proven
 * here on every platform.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ renameSync: vi.fn() }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, renameSync: mocks.renameSync };
});
// The keystore module calls `ensureConfigDir()` before writing; the directory
// under test is a real temp directory, so this only has to not create the
// user's real config directory during a test run.
vi.mock("@config/store.js", async () => {
  const actual = await vi.importActual<typeof import("@config/store.js")>("@config/store.js");
  return { ...actual, ensureConfigDir: () => undefined };
});

const { saveKeystoreFile } = await import("@tools/wallet/keystore.js");
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const OLD_BYTES = '{"version":1,"ciphertext":"old"}';

const KEYSTORE = {
  version: 1 as const,
  ciphertext: "bmV3",
  iv: "aXY=",
  salt: "c2FsdA==",
  tag: "dGFn",
  kdf: { name: "scrypt" as const, N: 2, r: 8, p: 1, dkLen: 32 },
};

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rename ${code}`), { code });
}

let dir: string;
let target: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "vex-keystore-rename-"));
  target = join(dir, "keystore.json");
  writeFileSync(target, OLD_BYTES, "utf-8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("saveKeystoreFile rename contention", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "retries %s and saves once the holder lets go",
    (code) => {
      let attempts = 0;
      mocks.renameSync.mockImplementation((from: string, to: string) => {
        attempts += 1;
        if (attempts <= 2) throw errno(code);
        actualFs.renameSync(from, to);
      });

      saveKeystoreFile(target, KEYSTORE);

      expect(attempts).toBe(3);
      // The world, not the self-report: the new keystore is on disk and the
      // temp file is gone.
      expect(JSON.parse(readFileSync(target, "utf-8")).ciphertext).toBe("bmV3");
      expect(readdirSync(dir)).toEqual(["keystore.json"]);
    },
  );

  it("refuses with a NAMED KEYSTORE_WRITE_LOCKED error, leaving the old keystore intact", () => {
    mocks.renameSync.mockImplementation(() => {
      throw errno("EPERM");
    });

    let thrown: unknown;
    try {
      saveKeystoreFile(target, KEYSTORE);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { code?: string; hint?: string };
    expect(error.code).toBe("KEYSTORE_WRITE_LOCKED");
    // The remedy names the class of program to close. A generic write failure
    // would leave the user with nothing to do.
    expect(String(error.hint)).toMatch(/antivirus|syncing|editor/i);
    expect(error.message).toMatch(/NOT changed/);
    // Four attempts: the first plus the three documented retries.
    expect(mocks.renameSync).toHaveBeenCalledTimes(4);
    // KEY MATERIAL SURVIVES. Nothing was lost, and no temp file was left.
    expect(readFileSync(target, "utf-8")).toBe(OLD_BYTES);
    expect(readdirSync(dir)).toEqual(["keystore.json"]);
  });

  it("does not retry an errno outside the policy", () => {
    mocks.renameSync.mockImplementation(() => {
      throw errno("EXDEV");
    });

    expect(() => saveKeystoreFile(target, KEYSTORE)).toThrow(/EXDEV/);
    expect(mocks.renameSync).toHaveBeenCalledTimes(1);
    expect(readFileSync(target, "utf-8")).toBe(OLD_BYTES);
    expect(existsSync(target)).toBe(true);
  });
});
