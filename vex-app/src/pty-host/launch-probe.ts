/**
 * The real filesystem behind `LaunchProbe`.
 *
 * Two things here are platform facts rather than choices, and both are copied
 * from VS Code's terminal process because they were learned from its bug
 * reports rather than from documentation:
 *
 *  - CWD TRACKING IS PLATFORM-SPECIFIC. Linux exposes it as
 *    `/proc/<pid>/cwd`, a symlink readable in one syscall. macOS has no such
 *    interface, so `lsof -OPln -p <pid> | grep cwd` is the only route, and it
 *    is a SUBPROCESS - which is precisely why this host reads cwd on triggers
 *    (Enter, ready, exit) instead of on the 200 ms title poll. Windows has
 *    neither, and reports the cwd it was launched with.
 *  - `LANG=en_US.UTF-8` is forced for the `lsof` call so its output is
 *    parseable regardless of the user's locale.
 *
 * Executable resolution walks `PATH` itself rather than trusting node-pty to
 * search, so that a missing shell is a TYPED refusal before spawn instead of a
 * native exception after it.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { IProcessEnvironment, LaunchProbe } from "./types.js";

const isWindows = process.platform === "win32";
const isMacintosh = process.platform === "darwin";

async function statOrNull(
  target: string,
): Promise<{ isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean } | null> {
  try {
    const result = await fs.lstat(target);
    if (result.isSymbolicLink()) {
      // Follow it: a shell reached through a symlink is a file for our purposes,
      // and refusing it would reject `/bin/sh` on most distributions.
      try {
        const target2 = await fs.stat(target);
        return {
          isDirectory: target2.isDirectory(),
          isFile: target2.isFile(),
          isSymbolicLink: true,
        };
      } catch {
        return { isDirectory: false, isFile: false, isSymbolicLink: true };
      }
    }
    return {
      isDirectory: result.isDirectory(),
      isFile: result.isFile(),
      isSymbolicLink: false,
    };
  } catch {
    return null;
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  const info = await statOrNull(candidate);
  return info !== null && (info.isFile || info.isSymbolicLink);
}

async function findExecutable(
  command: string,
  cwd: string,
  env: IProcessEnvironment,
): Promise<string | null> {
  if (path.isAbsolute(command)) {
    return (await isExecutableFile(command)) ? command : null;
  }
  if (command.includes(path.sep) || (isWindows && command.includes("/"))) {
    const resolved = path.resolve(cwd, command);
    return (await isExecutableFile(resolved)) ? resolved : null;
  }

  const rawPath = env.PATH ?? env.Path ?? "";
  const extensions = isWindows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((item) => item.length > 0)
    : [""];
  for (const dir of rawPath.split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

async function readCwd(pid: number): Promise<string | null> {
  if (pid <= 0) return null;

  if (isMacintosh) {
    return await new Promise<string | null>((resolve) => {
      exec(
        `lsof -OPln -p ${String(pid)} | grep cwd`,
        { env: { ...process.env, LANG: "en_US.UTF-8" }, timeout: 2_000 },
        (error, stdout) => {
          if (error || stdout === "") {
            resolve(null);
            return;
          }
          const start = stdout.indexOf("/");
          resolve(start === -1 ? null : stdout.substring(start, stdout.length - 1));
        },
      );
    });
  }

  if (process.platform === "linux") {
    try {
      return await fs.readlink(`/proc/${String(pid)}/cwd`);
    } catch {
      return null;
    }
  }

  // Windows: no supported interface. The caller keeps the spawn cwd, which is
  // the honest answer rather than a guess that drifts.
  return null;
}

export const filesystemLaunchProbe: LaunchProbe = {
  stat: statOrNull,
  findExecutable,
  readCwd,
};
