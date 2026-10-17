/**
 * What the Settings "Local runtime" section says the runtime is made of.
 *
 * SOURCES, the simplest that cannot drift from what actually runs:
 *
 *   - Release: `native-runtime.lock.json`, compiled into main. A packaged app
 *     ships exactly the trees that lock pins (the afterPack gate refuses any
 *     other file), so its release name is the shipped release.
 *   - Postgres and llama.cpp: the bundled binaries' own `--version`, run from
 *     the very trees the supervisors start (`locatePostgresBinaries`,
 *     `locateLlamaBinary`), so a local build or a fetched tree reports itself.
 *   - pgvector: `default_version` in that tree's `vector.control`, the version
 *     `CREATE EXTENSION vector` installs.
 *
 * A version the binary could not give is null, never a guess. The trees do
 * not change while the app runs, so the answer is read once per process.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import lock from "../../../../native-runtime.lock.json" with { type: "json" };
import { log } from "../../logger/index.js";
import { llamaCacheDir, locateLlamaBinary, locatePostgresBinaries, RUNTIME_DIR } from "../runtime-paths.js";
import { llamaEnv } from "./llama-supervisor.js";
import { postgresChildEnv } from "./postgres-supervisor.js";

export interface BundledVersions {
  readonly postgres: string | null;
  readonly pgvector: string | null;
  readonly llamaCpp: string | null;
}

const VERSION_TIMEOUT_MS = 10_000;

/** The pinned runtime release this build ships. */
export const NATIVE_RUNTIME_RELEASE: string = lock.release;

/** `postgres (PostgreSQL) 18.6` -> `18.6`. */
export function parsePostgresVersion(output: string): string | null {
  return /\(PostgreSQL\)\s+(\S+)/.exec(output)?.[1] ?? null;
}

/** `default_version = '0.8.7'` -> `0.8.7`. */
export function parseExtensionVersion(control: string): string | null {
  return /^\s*default_version\s*=\s*'([^']+)'/m.exec(control)?.[1] ?? null;
}

/** `version: 9115 (78fbbc2)` -> `b9115`, the llama.cpp release tag. */
export function parseLlamaVersion(output: string): string | null {
  const build = /^version:\s*(\d+)\b/m.exec(output)?.[1];
  return build === undefined ? null : `b${build}`;
}

function run(
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env: Record<string, string> },
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...options, timeout: VERSION_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null) {
          log.warn(`[runtime:native] ${path.basename(file)} ${args.join(" ")} failed: ${error.message}`);
          resolve(null);
          return;
        }
        // llama-server prints its version on stderr, Postgres on stdout.
        resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

async function readVersions(): Promise<BundledVersions> {
  const [pg, llama] = await Promise.all([locatePostgresBinaries(), locateLlamaBinary()]);
  let postgres: string | null = null;
  let pgvector: string | null = null;
  if (pg.kind === "found") {
    const tree = path.dirname(path.dirname(pg.binaries.postgres));
    const control = path.join(tree, "share", "postgresql", "extension", "vector.control");
    const [output, controlText] = await Promise.all([
      run(pg.binaries.postgres, ["--version"], { env: postgresChildEnv(process.platform) }),
      fs.readFile(control, "utf8").catch(() => null),
    ]);
    postgres = output === null ? null : parsePostgresVersion(output);
    pgvector = controlText === null ? null : parseExtensionVersion(controlText);
  }
  let llamaCpp: string | null = null;
  if (llama.kind === "found") {
    const output = await run(llama.binaryPath, ["--version"], {
      cwd: path.dirname(llama.binaryPath),
      // The server's own minimal environment; no key is needed to print a version.
      env: llamaEnv("", llamaCacheDir(RUNTIME_DIR)),
    });
    llamaCpp = output === null ? null : parseLlamaVersion(output);
  }
  return { postgres, pgvector, llamaCpp };
}

let cached: Promise<BundledVersions> | null = null;

/** Read once; an answer with a gap (a binary that timed out) is read again next time. */
export function bundledVersions(): Promise<BundledVersions> {
  if (cached !== null) return cached;
  const reading = readVersions();
  cached = reading;
  void reading.then((versions) => {
    if (Object.values(versions).some((value) => value === null) && cached === reading) cached = null;
  });
  return reading;
}
