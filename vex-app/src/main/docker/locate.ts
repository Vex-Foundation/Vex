/**
 * Single owner for "where is Docker installed on this machine".
 *
 * Why this module exists: `process.env` in the Electron main process is a
 * snapshot taken when the app launched. Windows gives a running process no
 * way to observe a later PATH change (the environment block is per-process
 * and fixed at creation), so a Docker Desktop installed AFTER Vex started is
 * invisible to any PATH-only detector until the app restarts. That is the
 * "I installed Docker but Vex still says install Docker" report.
 *
 * The fix is ordering: KNOWN INSTALL DIRECTORIES ARE PROBED ON THE
 * FILESYSTEM FIRST, and PATH is only the fallback. A filesystem probe is
 * immune to the stale environment snapshot.
 *
 * Path probing is a heuristic and never a decision procedure: Docker's
 * installer supports `--installation-dir=<path>`, so a fixed-path-only
 * detector would report "not installed" for a perfectly working Docker.
 * That is why PATH must remain in the chain.
 *
 * Everything here takes `platform`, `env`, `homedir` and `fileExists` as
 * injected parameters so Windows resolution is testable from any host OS.
 */

import { statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";

/** Where a located Docker CLI came from. Never carries the path itself
 * across the process boundary - a local install path is not renderer data. */
export type DockerCliSource = "install_dir" | "path";

export interface DockerCliLocation {
  /** Absolute path. Callers spawn THIS, never the bare name `docker`. */
  readonly executablePath: string;
  readonly source: DockerCliSource;
}

export interface LocatorContext {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
  /** True only for an existing, non-directory entry. */
  readonly fileExists: (candidate: string) => boolean;
}

/** Documented Windows default when PATHEXT is absent from the environment. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Reads an environment variable by a case-insensitive key match. Windows
 * environment names are case-insensitive and preserve first-set casing, so
 * `PATH` and `Path` are the same variable and either spelling can be the
 * one that actually exists.
 */
export function getEnvCaseInsensitive(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const direct = env[key];
  if (direct !== undefined) return direct;
  const lowercaseKey = key.toLowerCase();
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === lowercaseKey) return env[name];
  }
  return undefined;
}

/**
 * Resolves the key spelling an environment variable ALREADY uses, so a
 * caller can write back to that same key instead of creating a second one.
 * Assigning `PATH` to an environment that already carries `Path` produces
 * two entries for one Windows variable and the child process may inherit
 * the wrong one.
 */
export function resolveEnvKey(
  env: NodeJS.ProcessEnv,
  key: string,
): string | null {
  if (Object.prototype.hasOwnProperty.call(env, key)) return key;
  const lowercaseKey = key.toLowerCase();
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === lowercaseKey) return name;
  }
  return null;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function dedupe(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Docker Desktop install roots on Windows, in probe order.
 *
 * Per-user (`%LOCALAPPDATA%\Programs\DockerDesktop` - the directory name has
 * no space) is Docker's current DEFAULT install mode, so it is tried first;
 * the all-users mode installs under `<ProgramFiles>\Docker\Docker`.
 * `ProgramW6432` precedes `ProgramFiles` because a 32-bit host process sees
 * the redirected `Program Files (x86)` value in `ProgramFiles`.
 *
 * Both the CLI (`resources\bin`) and the GUI executable (`Docker
 * Desktop.exe`) live under these roots, which is why the probe and the
 * daemon starter share this one list.
 */
export function dockerDesktopInstallRoots(
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const win = path.win32;
  const roots: string[] = [];
  const localAppData = getEnvCaseInsensitive(env, "LOCALAPPDATA");
  if (nonEmpty(localAppData)) {
    roots.push(win.join(localAppData, "Programs", "DockerDesktop"));
  }
  for (const key of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]) {
    const base = getEnvCaseInsensitive(env, key);
    if (nonEmpty(base)) roots.push(win.join(base, "Docker", "Docker"));
  }
  return dedupe(roots);
}

/**
 * Directories that may hold the Docker CLI, in probe order.
 *
 * On Windows these are derived from the install roots above. Docker's
 * documentation proves `<installroot>\resources\bin` is the CLI tools
 * directory but does not name `docker.exe` there by path, so this is a
 * strong candidate rather than a certainty - hence the PATH fallback.
 */
export function dockerCliDirectories(ctx: {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
}): ReadonlyArray<string> {
  const { platform, homedir, env } = ctx;
  if (platform === "win32") {
    const win = path.win32;
    return dockerDesktopInstallRoots(env).map((root) =>
      win.join(root, "resources", "bin"),
    );
  }
  if (platform === "darwin") {
    return [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      path.posix.join(homedir, ".docker/bin"),
      path.posix.join(homedir, ".orbstack/bin"),
      path.posix.join(homedir, ".rd/bin"),
      "/Applications/Docker.app/Contents/Resources/bin",
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/local/bin",
      "/usr/bin",
      "/snap/bin",
      path.posix.join(homedir, "bin"),
    ];
  }
  return [];
}

/**
 * Finds `command` on the environment's PATH and returns its absolute path.
 *
 * Relative PATH entries are deliberately SKIPPED. The standard algorithm
 * resolves them against the current working directory; in a privileged main
 * process that would let the working directory decide which binary is
 * executed, which is not an acceptable trust boundary for a tool that will
 * be spawned.
 */
export function findExecutableOnPath(
  command: string,
  ctx: LocatorContext,
): string | null {
  const { platform, env, fileExists } = ctx;
  const p = pathApi(platform);
  const rawPath = getEnvCaseInsensitive(env, "PATH");
  if (!nonEmpty(rawPath)) return null;

  const delimiter = platform === "win32" ? ";" : ":";
  const names: string[] = [];
  if (platform === "win32") {
    const pathExt = getEnvCaseInsensitive(env, "PATHEXT") ?? DEFAULT_PATHEXT;
    for (const ext of pathExt.split(";")) {
      const trimmed = ext.trim();
      if (trimmed.length > 0) names.push(`${command}${trimmed}`);
    }
    // Extensionless last: PATHEXT decides what Windows would actually run.
    names.push(command);
  } else {
    names.push(command);
  }

  for (const rawEntry of rawPath.split(delimiter)) {
    // Windows tolerates quoted PATH entries containing spaces.
    const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (entry.length === 0) continue;
    if (!p.isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = p.join(entry, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Locates the Docker CLI: known install directories first, PATH second.
 * Returns `null` when neither strategy finds a file. This function performs
 * NO spawn - validation (running `--version` on the absolute path) is the
 * caller's step, so an unusable candidate is reported as a probe error and
 * never as "not installed".
 */
export function locateDockerCli(ctx: LocatorContext): DockerCliLocation | null {
  const { platform, fileExists } = ctx;
  const p = pathApi(platform);
  const exeName = platform === "win32" ? "docker.exe" : "docker";

  for (const dir of dockerCliDirectories(ctx)) {
    const candidate = p.join(dir, exeName);
    if (fileExists(candidate)) {
      return { executablePath: candidate, source: "install_dir" };
    }
  }

  const onPath = findExecutableOnPath("docker", ctx);
  return onPath === null ? null : { executablePath: onPath, source: "path" };
}

/** Locates the Docker Desktop GUI executable under the same install roots. */
export function locateDockerDesktopExe(ctx: {
  readonly env: NodeJS.ProcessEnv;
  readonly fileExists: (candidate: string) => boolean;
}): string | null {
  for (const root of dockerDesktopInstallRoots(ctx.env)) {
    const candidate = path.win32.join(root, "Docker Desktop.exe");
    if (ctx.fileExists(candidate)) return candidate;
  }
  return null;
}

/** Existing, non-directory entry. Mirrors what an exec would accept. */
export function isExistingFile(candidate: string): boolean {
  try {
    return !statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Real-environment locator. Deliberately UNCACHED: it is recomputed per
 * probe/spawn so "Recheck" observes a Docker installed while Vex was
 * already running. The cost is a handful of `statSync` calls.
 */
export function resolveDockerCli(): DockerCliLocation | null {
  return locateDockerCli({
    platform: process.platform,
    homedir: osHomedir(),
    env: process.env,
    fileExists: isExistingFile,
  });
}
