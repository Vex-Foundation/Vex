/**
 * PREFLIGHT: stage the pinned native runtime trees (Postgres + pgvector,
 * llama-server) for the platform being packaged, or fail the build.
 *
 * Runs before electron-builder in every packaging path, beside
 * `stage-bridge.mjs` and `stage-lighter-signer.mjs`, for their reason:
 * electron-builder 26 only WARNS on a missing `extraResources` source, so
 * without this step a package could ship with no database or embeddings server
 * and nobody would learn until a user's first run.
 *
 * For each requested Electron arch it stages `resources/postgres-<arch>/` and
 * `resources/llama-<arch>/` from the fetched target
 * (`resources/native-runtime/<target>/`, see `fetch-native-runtime.mjs`), which
 * `extraResources` packages as `postgres/` and `llama/`. Per arch because the
 * macOS and Windows jobs package both arches in one invocation.
 *
 * EVERYTHING IS VERIFIED BEFORE ANYTHING IS WRITTEN: for every requested arch,
 * the fetched listing against the lock, and every fetched file against the
 * listing (exact set, required manifest, headers, exec bits, sha256). A target
 * that fails leaves every previous staging directory intact.
 *
 * Each staging directory is CLEARED, then the tree is copied FILE BY FILE (Node
 * 22's `fs.cpSync` copies nothing, without an error, into a Windows path with
 * non-ASCII characters - native-runtime/README.md), executables are set 0755
 * and everything else 0644, and the STAGED bytes are verified again: they are
 * what gets packaged. The internal layout is kept exactly: Postgres finds
 * `lib/` and `share/` relative to `bin/`, and llama-server loads its CPU
 * backends from its own directory.
 *
 * ON WINDOWS each staged directory also gets `AUTHENTICODE-SHA256SUMS`: the
 * Authenticode content digest of every PE, computed while the bytes are still
 * provably the lock's. electron-builder signs `.exe` and `.dll` files while
 * copying them into the package, so this is the value the packaged-tree gate
 * binds the signed files back to; computing it here makes a PE this repository
 * cannot parse fail in the preflight rather than halfway through a signed
 * release. The win32-arm64 target stages the x64 Postgres tree its release
 * tarball carries (PostgreSQL 18 has no MSVC ARM64 build).
 *
 * Usage (from vex-app/):
 *   node scripts/stage-native-runtime.mjs --platform mac --arch arm64 --arch x64
 *   node scripts/stage-native-runtime.mjs                 # every runtime arch of this host's platform
 */

import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authenticodeContentSha256 } from "./lighter-signer-artifact.mjs";
import {
  canonicalNativeRuntimePlatform,
  evaluateNativeRuntimeTree,
  executableFormatOf,
  fetchedNativeRuntimeDir,
  listTreeFiles,
  NATIVE_RUNTIME_AUTHENTICODE_FILE,
  NATIVE_RUNTIME_COMPONENTS,
  nativeRuntimeTargetFor,
  nativeRuntimeTargetsForPlatform,
  readFetchedListing,
  readNativeRuntimeLock,
  renderAuthenticodeManifest,
  stagedNativeRuntimeDir,
} from "./native-runtime-artifact.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  let platform = process.platform;
  const arches = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--platform" || flag === "--arch") {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === "--platform") platform = value;
      else arches.push(value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}; accepts --platform and --arch`);
  }
  return { platform, arches };
}

function componentDirs(base) {
  return Object.fromEntries(NATIVE_RUNTIME_COMPONENTS.map((component) => [component, path.join(base, component)]));
}

/**
 * Stage the runtime for one platform and the given Electron arches (default:
 * every arch the runtime has a target for on that platform). Returns one entry
 * per staged arch. `appRoot` is a test seam; production callers pass nothing.
 */
export function stageNativeRuntime(platform, arches = [], { appRoot = APP_ROOT } = {}) {
  const canonical = canonicalNativeRuntimePlatform(platform);
  const targets = arches.length > 0
    ? arches.map((arch) => nativeRuntimeTargetFor(canonical, arch))
    : nativeRuntimeTargetsForPlatform(canonical);
  const lock = readNativeRuntimeLock(appRoot);

  // 1. Verify every requested target before any staging directory is touched.
  const verified = targets.map((target) => {
    const source = fetchedNativeRuntimeDir(appRoot, target);
    try {
      const listing = readFetchedListing(appRoot, target, lock);
      const { issues } = evaluateNativeRuntimeTree(componentDirs(source), target, listing);
      if (issues.length > 0) throw new Error(issues.join("\n    - "));
      return { target, source, listing };
    } catch (error) {
      throw new Error(
        `the native runtime for ${target.name} is not usable:\n    - ${error.message}\n`
          + `    Fetch it first: node scripts/fetch-native-runtime.mjs --target ${target.name}\n`
          + "    Packaging without it would ship a Vex with no database or embeddings server."
      );
    }
  });

  // 2. Write.
  return verified.map(({ target, source, listing }) => {
    const staged = Object.fromEntries(
      NATIVE_RUNTIME_COMPONENTS.map((component) => [component, stagedNativeRuntimeDir(appRoot, component, target.arch)])
    );
    for (const dir of Object.values(staged)) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // Build output, never source; the directory is recreated on every run,
      // so it carries its own ignore rule. The profiles filter it out of the
      // package.
      writeFileSync(path.join(dir, ".gitignore"), "*\n");
    }
    for (const entry of listTreeFiles(componentDirs(source))) {
      const [component, ...rest] = entry.path.split("/");
      const destination = path.join(staged[component], ...rest);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(entry.file, destination);
      // electron-builder preserves the mode into the package, and Postgres or
      // llama-server without its execute bit cannot be spawned.
      chmodSync(destination, executableFormatOf(destination) === undefined ? 0o644 : 0o755);
    }

    // 3. Re-verify the STAGED bytes: they are what gets packaged.
    const { issues, files } = evaluateNativeRuntimeTree(staged, target, listing, { allowStagingMetadata: true });
    if (issues.length > 0) {
      throw new Error(`the staged ${target.name} runtime failed re-verification:\n    - ${issues.join("\n    - ")}`);
    }

    // 4. Windows: the pre-sign record electron-builder's signing cannot change.
    let authenticode = 0;
    if (target.platform === "win32") {
      for (const component of NATIVE_RUNTIME_COMPONENTS) {
        const records = files
          .filter((file) => file.format === "pe" && file.path.startsWith(`${component}/`))
          .map((file) => ({ path: file.path, digest: authenticodeContentSha256(file.file) }));
        writeFileSync(path.join(staged[component], NATIVE_RUNTIME_AUTHENTICODE_FILE), renderAuthenticodeManifest(records));
        authenticode += records.length;
      }
    }
    return {
      target,
      staged,
      files: files.length,
      executables: files.filter((file) => file.format !== undefined).length,
      authenticode,
    };
  });
}

function main() {
  const { platform, arches } = parseArgs(process.argv.slice(2));
  const lock = readNativeRuntimeLock(APP_ROOT);
  for (const result of stageNativeRuntime(platform, arches)) {
    const where = Object.values(result.staged).map((dir) => path.relative(APP_ROOT, dir)).join(" + ");
    console.log(
      `native-runtime: staged ${result.target.name} (${lock.release}) -> ${where}: ${result.files} files, `
        + `${result.executables} executables verified against the lock`
        + `${result.target.platform === "win32" ? `, ${result.authenticode} Authenticode content digests recorded` : ""}`
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
