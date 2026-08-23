import { statSync } from "node:fs";
import { homedir as getHomedir } from "node:os";
import { dockerCliDirectories, resolveEnvKey } from "./locate.js";
import { withoutManagedSecrets } from "./env-hygiene.js";

export interface BuildDockerPathOptions {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dirExists: (path: string) => boolean;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function comparableEntry(platform: NodeJS.Platform, entry: string): string {
  // Windows paths are case-insensitive and a trailing separator is noise.
  return platform === "win32"
    ? entry.toLowerCase().replace(/[\\/]+$/, "")
    : entry;
}

/**
 * Builds the environment used for Docker CLI processes. Existing PATH entries
 * retain priority; only present, missing candidates are appended.
 *
 * Windows hazard, handled explicitly: Windows environment names are
 * case-insensitive, so `PATH` and `Path` are the SAME variable. Writing a
 * literal `PATH` key into an environment that already carries `Path` would
 * hand `child_process` two entries for one variable. `resolveEnvKey` finds
 * the spelling the environment already uses and the value is written back to
 * THAT key, so the object always carries exactly one path variable.
 *
 * This function used to return `process.env` by identity on Windows, which
 * meant Windows augmentation never happened at all. It is not a substitute
 * for `locate.ts`: augmenting a stale PATH cannot reveal an install the
 * snapshot never saw, which is why detection resolves the CLI on the
 * filesystem first and this only shapes the child's environment.
 */
export function buildDockerPath(
  options: BuildDockerPathOptions,
): NodeJS.ProcessEnv {
  const { platform, homedir, env, dirExists } = options;
  const delimiter = pathDelimiter(platform);
  const pathKey = resolveEnvKey(env, "PATH") ?? "PATH";
  const inheritedPath = env[pathKey] ?? "";
  const knownEntries = new Set(
    inheritedPath
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => comparableEntry(platform, entry)),
  );
  const appended = dockerCliDirectories({ platform, homedir, env }).filter(
    (candidate) =>
      !knownEntries.has(comparableEntry(platform, candidate)) &&
      dirExists(candidate),
  );
  const path = [inheritedPath, ...appended].filter(Boolean).join(delimiter);

  return { ...env, [pathKey]: path };
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recomputes Docker CLI candidates per spawn so Recheck sees new installs,
 * and strips managed secrets so the Docker CLI/compose child never inherits
 * the master password or vault-managed API keys.
 */
export function dockerSpawnEnv(): NodeJS.ProcessEnv {
  return withoutManagedSecrets(
    buildDockerPath({
      platform: process.platform,
      homedir: getHomedir(),
      env: process.env,
      dirExists: directoryExists,
    }),
  );
}
