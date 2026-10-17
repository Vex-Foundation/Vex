/**
 * Where the native runtime keeps its state, and where its binaries are.
 *
 * RUNTIME_DIR. `CONFIG_DIR/runtime` on macOS and Linux. On Windows CONFIG_DIR
 * is the ROAMING `%APPDATA%\vex`, which a domain profile can sync between
 * machines, so a database must not live there: the runtime goes to
 * `%LOCALAPPDATA%\vex\runtime` instead. An explicit `VEX_CONFIG_DIR` (the
 * isolated-install and e2e override) keeps the runtime under it on every OS,
 * otherwise two isolated installs on one Windows machine would share a
 * cluster.
 *
 * BINARIES. Two places, decided by packaging, never by a search (the same rule
 * as `studio/installer/bridge-path.ts`):
 *
 *   - PACKAGED: `<resources>/postgres/bin/<name>[.exe]`.
 *   - DEVELOPMENT: `<repo>/native-runtime/out/<platform>-<arch>/postgres/bin`,
 *     where `native-runtime/postgres/build.sh` puts the tree, or the tree named
 *     by `VEX_NATIVE_PG_DIR` (absolute only). A packaged build ignores that
 *     variable: the app must never run a Postgres it did not ship.
 *
 * Every path is absolute and checked `X_OK`; a bare name would let whatever
 * `postgres` is first on the user's PATH run with Vex's authority.
 */

import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { CONFIG_DIR, flavour } from "../paths/config-dir.js";

interface RuntimeDirDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configDir: string;
}

function absoluteEnv(value: string | undefined, target: path.PlatformPath): string | null {
  return typeof value === "string" && value.length > 0 && target.isAbsolute(value) ? value : null;
}

export function resolveRuntimeDir(deps: RuntimeDirDeps): string {
  const target = flavour(deps.platform);
  if (deps.platform !== "win32" || absoluteEnv(deps.env["VEX_CONFIG_DIR"], target) !== null) {
    return target.join(deps.configDir, "runtime");
  }
  const localAppData =
    absoluteEnv(deps.env["LOCALAPPDATA"], target) ?? target.join(deps.homedir, "AppData", "Local");
  return target.join(localAppData, "vex", "runtime");
}

export const RUNTIME_DIR = resolveRuntimeDir({
  platform: process.platform,
  homedir: homedir(),
  env: process.env,
  configDir: CONFIG_DIR,
});

/** The cluster's data directory. Named by major so PG19 can sit beside it. */
export function pgDataDir(runtimeDir: string): string {
  return path.join(runtimeDir, "pg18");
}

export function runtimeStatePath(runtimeDir: string): string {
  return path.join(runtimeDir, "runtime-state.json");
}

/** The migration's dump and source facts (runtime/migration/). */
export function migrationDir(runtimeDir: string): string {
  return path.join(runtimeDir, "migration");
}

/** Where the verified embeddings model lives (model-store.ts). */
export function modelsDir(runtimeDir: string): string {
  return path.join(runtimeDir, "models");
}

/** LLAMA_CACHE for llama-server: required by b9115, never written (--offline). */
export function llamaCacheDir(runtimeDir: string): string {
  return path.join(runtimeDir, "llama-cache");
}

/** The binaries the supervisor runs. pg_ctl is used on Windows only. */
export interface PostgresBinaries {
  readonly postgres: string;
  readonly initdb: string;
  readonly pgCtl: string;
  readonly pgControldata: string;
}

export type PostgresBinariesLocation =
  | { readonly kind: "found"; readonly binaries: PostgresBinaries }
  | { readonly kind: "unavailable"; readonly detail: string };

/** Electron's arch vocabulary as the native-runtime build names targets. */
const TARGET_ARCH: Readonly<Record<string, string>> = { x64: "x64", arm64: "arm64" };

/**
 * A development tree: a local build (`native-runtime/out/<target>/`) wins,
 * else the lock-pinned release `pnpm dev:assets` fetched
 * (`vex-app/resources/native-runtime/<target>/`). `probe` names a file that
 * exists only in a complete tree.
 */
function developmentTree(repoRoot: string, target: string, component: string, probe: string): string {
  const built = path.join(repoRoot, "native-runtime", "out", target, component);
  const fetched = path.join(repoRoot, "vex-app", "resources", "native-runtime", target, component);
  return !existsSync(path.join(built, probe)) && existsSync(path.join(fetched, probe)) ? fetched : built;
}

/**
 * The absolute bin paths, or a named reason they are not there. Every option
 * is a test seam; production callers pass nothing.
 */
export async function locatePostgresBinaries(options?: PostgresTreeOptions): Promise<PostgresBinariesLocation> {
  const found = await locatePostgresPrograms(
    { postgres: "postgres", initdb: "initdb", pgCtl: "pg_ctl", pgControldata: "pg_controldata" },
    options,
  );
  return found.kind === "found" ? { kind: "found", binaries: found.paths } : found;
}

/** The bundled client tools the data migration runs (6.1, plan section 10). */
export interface PostgresClientTools {
  readonly pgDump: string;
  readonly pgRestore: string;
}

export type PostgresClientToolsLocation =
  | { readonly kind: "found"; readonly tools: PostgresClientTools }
  | { readonly kind: "unavailable"; readonly detail: string };

/** `pg_dump` and `pg_restore` from the same tree, by the same rules. */
export async function locatePostgresClientTools(options?: PostgresTreeOptions): Promise<PostgresClientToolsLocation> {
  const found = await locatePostgresPrograms({ pgDump: "pg_dump", pgRestore: "pg_restore" }, options);
  return found.kind === "found" ? { kind: "found", tools: found.paths } : found;
}

export interface PostgresTreeOptions {
  readonly packaged?: boolean;
  readonly resourcesPath?: string;
  readonly repoRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** `programs` (key -> program name) in the Postgres tree's bin/, each checked X_OK. */
async function locatePostgresPrograms<K extends string>(
  programs: Readonly<Record<K, string>>,
  options: PostgresTreeOptions | undefined,
): Promise<
  | { readonly kind: "found"; readonly paths: Record<K, string> }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const platform = options?.platform ?? process.platform;
  const packaged = options?.packaged ?? app.isPackaged;
  const env = options?.env ?? process.env;

  let treeDir: string;
  if (packaged) {
    treeDir = path.join(options?.resourcesPath ?? process.resourcesPath, "postgres");
  } else {
    const override = absoluteEnv(env["VEX_NATIVE_PG_DIR"], path);
    const arch = TARGET_ARCH[options?.arch ?? process.arch];
    if (override !== null) {
      treeDir = override;
    } else if (arch === undefined) {
      return { kind: "unavailable", detail: `Vex builds no Postgres tree for ${platform}/${options?.arch ?? process.arch}.` };
    } else {
      const repoRoot = options?.repoRoot ?? path.resolve(app.getAppPath(), "..");
      const exe = platform === "win32" ? "postgres.exe" : "postgres";
      treeDir = developmentTree(repoRoot, `${platform}-${arch}`, "postgres", path.join("bin", exe));
    }
  }

  const paths = {} as Record<K, string>;
  for (const key of Object.keys(programs) as K[]) {
    const name = programs[key];
    paths[key] = path.join(treeDir, "bin", platform === "win32" ? `${name}.exe` : name);
  }
  for (const candidate of Object.values<string>(paths)) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      return {
        kind: "unavailable",
        detail: packaged
          ? `The bundled Postgres is missing or not executable (${path.basename(candidate)}). Reinstall Vex.`
          : `No executable ${candidate}. Run pnpm dev:assets (fetches the pinned release), build it with native-runtime/postgres/build.sh, or set VEX_NATIVE_PG_DIR.`,
      };
    }
  }
  return { kind: "found", paths };
}

export type LlamaBinaryLocation =
  | { readonly kind: "found"; readonly binaryPath: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * The bundled llama-server, by the same rules as the Postgres binaries:
 * `<resources>/llama/` when packaged; `<repo>/native-runtime/out/<target>/llama/`
 * or an absolute `VEX_NATIVE_LLAMA_DIR` in development (ignored when packaged).
 */
export async function locateLlamaBinary(options?: {
  readonly packaged?: boolean;
  readonly resourcesPath?: string;
  readonly repoRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<LlamaBinaryLocation> {
  const platform = options?.platform ?? process.platform;
  const packaged = options?.packaged ?? app.isPackaged;
  const env = options?.env ?? process.env;

  let treeDir: string;
  if (packaged) {
    treeDir = path.join(options?.resourcesPath ?? process.resourcesPath, "llama");
  } else {
    const override = absoluteEnv(env["VEX_NATIVE_LLAMA_DIR"], path);
    const arch = TARGET_ARCH[options?.arch ?? process.arch];
    if (override !== null) {
      treeDir = override;
    } else if (arch === undefined) {
      return { kind: "unavailable", detail: `Vex builds no llama-server for ${platform}/${options?.arch ?? process.arch}.` };
    } else {
      const repoRoot = options?.repoRoot ?? path.resolve(app.getAppPath(), "..");
      const exe = platform === "win32" ? "llama-server.exe" : "llama-server";
      treeDir = developmentTree(repoRoot, `${platform}-${arch}`, "llama", exe);
    }
  }

  const binaryPath = path.join(treeDir, platform === "win32" ? "llama-server.exe" : "llama-server");
  try {
    await access(binaryPath, constants.X_OK);
  } catch {
    return {
      kind: "unavailable",
      detail: packaged
        ? "The bundled embeddings server is missing or not executable. Reinstall Vex."
        : `No executable ${binaryPath}. Run pnpm dev:assets (fetches the pinned release), build it with native-runtime/llama/build.sh, or set VEX_NATIVE_LLAMA_DIR.`,
    };
  }
  return { kind: "found", binaryPath };
}
