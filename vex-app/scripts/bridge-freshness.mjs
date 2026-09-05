/**
 * IS THE BUILT Vex Studio BRIDGE STILL THE ONE THESE SOURCES PRODUCE?
 *
 * `pnpm dev` has to build the Go bridge or the Studio installer writes nothing
 * at all: `locateStudioBridge` looks at exactly one absolute path,
 * `bridge/dist/<goos>-<goarch>/vex-mcp`, and reports `unavailable` when it is
 * not there. Building it unconditionally on every `pnpm dev` would add a Go
 * link to every single start, so the dev path needs a cheap, HONEST answer to
 * "is the artifact on disk the one these sources produce?".
 *
 * MTIME IS NOT THAT ANSWER. A branch switch, a rebase, a `git stash pop` or a
 * fresh clone all rewrite mtimes without changing content, and a checkout of
 * an OLDER revision moves content backwards while moving mtime forwards. This
 * module hashes instead:
 *
 *   sources digest  every file under `bridge/` that can change the emitted
 *                   binary: all `*.go` (test files included - excluding them
 *                   would trade a harmless rebuild for a possible miss),
 *                   `go.mod`, `go.sum` when present, and `build.sh`, whose
 *                   ldflags and GOAMD64/GOARM64 pins are part of the output.
 *   target triple   `<goos>-<goarch>`, so the manifest for one target can
 *                   never vouch for another.
 *   toolchain       the EXACT `go env GOVERSION`. `bridge/build.sh` pins one
 *                   patch on purpose, so a toolchain change is a source change.
 *   artifact digests the sha256 and byte length of EVERY binary the artifact
 *                   table lists for this triple, re-read on every check.
 *                   Without them a hand-replaced or half-written binary would
 *                   keep passing because the manifest beside it still matched -
 *                   and, once `bridge/` emitted a second artifact, a manifest
 *                   that vouched only for `vex-mcp` would have let a missing,
 *                   replaced or foreign `vex-pipe-front.exe` beside it read as
 *                   fresh forever.
 *
 * Every consumer addresses these artifacts BY NAME from the table; nothing
 * reads the output directory whole, so a file that is not a table artifact is
 * not this check's question (see the end of `evaluateBridgeFreshness`).
 *
 * The manifest lives in the build output directory (`bridge/dist/` is
 * git-ignored), so it is discarded exactly when the artifact it describes is.
 *
 * THE TWO PREREQUISITES LIVE HERE TOO, for the same reason the freshness
 * check does: `build-host-bridges.mjs` and `doctor.mjs` must answer "can this
 * machine build the bridge, and with what?" identically, and a second copy of
 * either answer is a second source of truth. `resolveGoToolchain` owns the Go
 * pin; `resolveBuildShell` owns which `bash` runs `bridge/build.sh`.
 *
 * THE TOOLCHAIN IS REQUIRED, NOT OPTIONAL. A missing or wrong `go` is answered
 * with a named refusal that points at `bridge/build.sh` and `vex-app/DEV.md`,
 * never with a skip: a silent skip is how a developer ends up debugging an
 * installer that "writes no files" when the real cause is a build that never
 * ran.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  GO_ARCH_BY_ELECTRON_ARCH,
  GOOS_BY_ELECTRON_PLATFORM,
  artifactsFor,
  assertBridgeArtifact,
  builtArtifactPath,
} from "./bridge-artifact.mjs";

/** The build wrapper every packaging and dev path calls. Repo-root relative. */
export const BRIDGE_BUILD_SCRIPT = path.join("bridge", "build.sh");

/** File name of the freshness record, inside the target's output directory. */
export const BRIDGE_MANIFEST_NAME = "build-manifest.json";

/**
 * Bumped when the stamp's inputs or encoding change, so old records go stale.
 *
 * v2 (2026-09-02) replaced the single `artifactDigest` string with an
 * `artifacts` map (name -> sha256 + byte length), because `bridge/` now emits
 * more than one binary per triple. COMPATIBILITY IS ONE-WAY BY CONSTRUCTION:
 * the version is an input to `freshnessStamp`, so a v1 record's stamp can never
 * equal a v2 stamp and every pre-existing manifest reads as STALE - never as
 * fresh, and never as a crash on a missing field. The remedy is the rebuild
 * that staleness already triggers, which rewrites the record in the new shape.
 * `bridge/dist/` is git-ignored, so no committed artifact carries the old form.
 */
const MANIFEST_VERSION = 2;

/**
 * The Go version `bridge/build.sh` pins, read FROM the script.
 *
 * The pin has one owner. Copying `go1.27.0` into a second file would let the
 * two drift and let this module vouch for a toolchain the build itself
 * refuses.
 */
export function requiredGoVersion(repoRoot) {
  const script = path.join(repoRoot, BRIDGE_BUILD_SCRIPT);
  const source = readFileSync(script, "utf8");
  const match = /^readonly REQUIRED_GO_VERSION="([^"]+)"/m.exec(source);
  if (match === null) {
    throw new Error(
      `${script} no longer declares REQUIRED_GO_VERSION; the Go pin has one owner and `
        + "this reader must be updated with it"
    );
  }
  return match[1];
}

/**
 * The Go target for the machine running this script, refused BY NAME when Vex
 * has no bridge build for it.
 */
export function hostGoTarget(platform = process.platform, arch = process.arch) {
  const goos = GOOS_BY_ELECTRON_PLATFORM[platform];
  const goarch = GO_ARCH_BY_ELECTRON_ARCH[arch];
  if (goos === undefined || goarch === undefined) {
    throw new Error(
      `Vex builds no Studio bridge for ${platform}/${arch}; the bridge targets `
        + "darwin, windows and linux on x64 and arm64 only"
    );
  }
  return { goos, goarch };
}

/**
 * Every file under `bridge/` whose content can change the emitted binary,
 * as repo-root-relative POSIX paths, sorted so the digest is stable across
 * filesystems that enumerate directories in different orders.
 */
export function bridgeSourceFiles(repoRoot) {
  const bridgeDir = path.join(repoRoot, "bridge");
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // `dist` is this module's own output, not an input.
      if (entry.isDirectory()) {
        if (dir === bridgeDir && entry.name === "dist") continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name;
      const isInput =
        name.endsWith(".go") || name === "go.mod" || name === "go.sum" || name === "build.sh";
      if (!isInput) continue;
      found.push(path.relative(repoRoot, path.join(dir, name)).split(path.sep).join("/"));
    }
  };

  walk(bridgeDir);
  found.sort();
  if (found.length === 0) {
    throw new Error(`${bridgeDir} contains no Go sources; nothing could be built from it`);
  }
  return found;
}

/** sha256 over the bridge's build inputs, path and content both. */
export function hashBridgeSources(repoRoot) {
  const hash = createHash("sha256");
  for (const relative of bridgeSourceFiles(repoRoot)) {
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(path.join(repoRoot, relative))).digest());
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** sha256 of a file on disk, or `null` when it is not there. */
export function hashFile(file) {
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The single value that has to match for a build to be skippable. */
export function freshnessStamp({ sourcesDigest, goos, goarch, goVersion }) {
  return createHash("sha256")
    .update(`v${MANIFEST_VERSION}\n${sourcesDigest}\n${goos}-${goarch}\n${goVersion}\n`, "utf8")
    .digest("hex");
}

/** Where one target's freshness record lives. */
export function manifestPath(repoRoot, goos, goarch) {
  return path.join(repoRoot, "bridge", "dist", `${goos}-${goarch}`, BRIDGE_MANIFEST_NAME);
}

/** The record, or `null` when it is absent or not readable as this format. */
export function readManifest(repoRoot, goos, goarch) {
  const file = manifestPath(repoRoot, goos, goarch);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    // A corrupt record means "unknown", which is stale. It is never a failure:
    // the answer is to rebuild, and the rebuild rewrites it.
    return null;
  }
}

/**
 * Write the record for a target that was just built.
 *
 * EVERY artifact the table lists for this triple is digested, and a missing one
 * throws rather than being recorded as absent: a manifest that omits an
 * artifact is a manifest that would later vouch for its absence.
 */
export function writeManifest(repoRoot, { goos, goarch, goVersion, sourcesDigest }) {
  const artifacts = {};
  for (const artifact of artifactsFor(goos, goarch)) {
    const file = builtArtifactPath(repoRoot, artifact, goos, goarch);
    const sha256 = hashFile(file);
    if (sha256 === null) {
      throw new Error(`${file} is missing after the build reported success`);
    }
    artifacts[artifact.name] = { sha256, bytes: statSync(file).size };
  }

  const file = manifestPath(repoRoot, goos, goarch);
  mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    manifestVersion: MANIFEST_VERSION,
    goos,
    goarch,
    goVersion,
    sourcesDigest,
    artifacts,
    stamp: freshnessStamp({ sourcesDigest, goos, goarch, goVersion }),
    builtAt: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/**
 * Ask `go` which toolchain it is, the same way `bridge/build.sh` does.
 *
 * `GOTOOLCHAIN=local` matters: without it Go reports (and silently downloads)
 * whatever a `toolchain` directive asks for, which would let this check pass
 * against a toolchain the build then refuses.
 */
export function detectGoToolchain() {
  const result = spawnSync("go", ["env", "GOVERSION"], {
    encoding: "utf8",
    env: { ...process.env, GOTOOLCHAIN: "local" },
  });
  if (result.error !== undefined && result.error.code === "ENOENT") {
    return { kind: "missing" };
  }
  if (result.error !== undefined) {
    return { kind: "unusable", detail: result.error.message };
  }
  if (result.status !== 0) {
    return {
      kind: "unusable",
      detail: `go env GOVERSION exited ${result.status}: ${(result.stderr ?? "").trim()}`,
    };
  }
  const version = (result.stdout ?? "").trim();
  if (version === "") {
    return { kind: "unusable", detail: "go env GOVERSION printed nothing" };
  }
  return { kind: "ok", version };
}

/**
 * The toolchain the build will use, or a sentence a developer can act on.
 *
 * Returns `{ kind: "ok", version }` or `{ kind: "refused", message }`. Never a
 * skip: the caller's job is to stop, not to continue without a bridge.
 *
 * `detected` is injectable so the refusals can be exercised without uninstalling
 * Go; production callers pass nothing.
 */
export function resolveGoToolchain(repoRoot, detected = detectGoToolchain()) {
  const required = requiredGoVersion(repoRoot);

  if (detected.kind === "missing") {
    return {
      kind: "refused",
      message:
        `no 'go' on PATH, so the Vex Studio bridge cannot be built. Vex needs Go `
        + `${required} EXACTLY (the pin is a pin, not a minimum: a different patch `
        + `changes the emitted binary).\n`
        + `    Install it, then re-run. The build itself is ${BRIDGE_BUILD_SCRIPT}; `
        + "the prerequisite is documented in vex-app/DEV.md.\n"
        + "    Without the bridge, Vex Studio writes no coding-agent config files at all.",
    };
  }
  if (detected.kind === "unusable") {
    return {
      kind: "refused",
      message:
        `'go' is on PATH but did not report its version: ${detected.detail}\n`
        + `    Vex needs Go ${required} exactly; see ${BRIDGE_BUILD_SCRIPT} and vex-app/DEV.md.`,
    };
  }
  if (detected.version !== required) {
    return {
      kind: "refused",
      message:
        `this toolchain reports '${detected.version}'; the Vex Studio bridge is pinned to `
        + `'${required}'.\n`
        + "    The pin is exact, not a minimum: a different patch changes the emitted binary.\n"
        + `    ${BRIDGE_BUILD_SCRIPT} refuses the same mismatch; see vex-app/DEV.md.`,
    };
  }
  return { kind: "ok", version: detected.version };
}

/**
 * WHICH `bash` RUNS `bridge/build.sh`?
 *
 * On Windows, `bash` is the wrong question to ask PATH. Every Windows box with
 * WSL enabled carries `%SystemRoot%\System32\bash.exe`, the WSL launcher, and
 * it is on the system PATH ahead of anything an installer adds. Spawning
 * `bash` there hands `bridge/build.sh` to a Linux distribution that receives
 * Windows paths it cannot resolve and a Go toolchain that is not the one this
 * module just vouched for. MEASURED on the owner's machine (2026-09-04): Git
 * for Windows was installed at `C:\Program Files\Git\bin\bash.exe`, `where
 * bash` answered `C:\Windows\System32\bash.exe` first, and the bridge build
 * failed inside WSL.
 *
 * So the Windows shell is RESOLVED, never looked up:
 *
 *   1. `VEX_GIT_BASH`, for an install in neither default place. An override
 *      that is set and not usable REFUSES; it never falls through to a guess,
 *      because a developer who pointed at a shell deserves to hear that the
 *      pointer is wrong rather than watch a different shell run.
 *   2. `git --exec-path`, which is where Git for Windows itself is, walked up
 *      to the install root: the same Git that cloned this repository names the
 *      Git Bash beside it. `--exec-path` reports
 *      `<root>\mingw64\libexec\git-core`, so the root is several levels up and
 *      each ancestor is tested rather than one guessed depth.
 *   3. The two default install roots, `%ProgramFiles%\Git` and
 *      `%LocalAppData%\Programs\Git` (system-wide and per-user installers).
 *
 * A candidate under `System32` or `SysWOW64` is refused at every step, in the
 * override too: those are WSL, whatever asked for them.
 *
 * On POSIX, PATH `bash` is correct and is what the CI jobs already use.
 *
 * Adopted from VS Code `src/vs/base/node/powershell.ts` (ordered explicit
 * candidates, each with a source label and an existence probe, first hit wins)
 * and `src/vs/base/node/processes.ts` (`getCaseInsensitive` for environment
 * lookups: `process.env` is case-insensitive on Windows, a plain object is
 * not, and the candidates must not depend on which spelling of `ProgramFiles`
 * the caller happened to pass).
 */

/** Environment variable that names an explicit Git Bash. */
export const GIT_BASH_OVERRIDE_ENV = "VEX_GIT_BASH";

/** Where a Git for Windows install keeps `bash.exe`, root-relative, in order. */
const GIT_BASH_RELATIVE_PATHS = [
  ["bin", "bash.exe"],
  ["usr", "bin", "bash.exe"],
];

/** The default install roots, as environment variable plus subdirectory. */
const GIT_INSTALL_ROOTS = [
  { variable: "ProgramFiles", subdirectory: "Git" },
  { variable: "LOCALAPPDATA", subdirectory: path.win32.join("Programs", "Git") },
];

/** How many levels above `git --exec-path` are searched for the install root. */
const GIT_EXEC_PATH_ANCESTORS = 5;

/** `process.env` is case-insensitive on Windows; an injected object is not. */
function environmentValue(env, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) {
      const value = env[key];
      return typeof value === "string" && value.trim() !== "" ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Is this the WSL launcher rather than a shell?
 *
 * The directory is what identifies it: Windows keeps `bash.exe` in `System32`
 * (and its 32-bit view `SysWOW64`), and no Git for Windows install puts one
 * there. Matching the directory rather than a fixed `C:\Windows` also holds on
 * a machine whose `%SystemRoot%` is not on C:.
 */
export function isWindowsSystemBash(file) {
  const directory = path.win32.basename(path.win32.dirname(file)).toLowerCase();
  return directory === "system32" || directory === "syswow64";
}

/** The default existence probe: a real file, not a directory. */
function isExistingFile(file) {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Ask the installed Git where its executables live, or `null` when there is no
 * usable `git`. Never throws: a machine without Git is answered by the
 * remaining candidates, and refused by name if they miss too.
 */
export function detectGitExecPath() {
  try {
    const result = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    if (result.error !== undefined || result.status !== 0) return null;
    const value = (result.stdout ?? "").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Every place a Git for Windows `bash.exe` could be, in probe order, each
 * labelled with the evidence that suggested it. The override is NOT here: it
 * refuses instead of falling through, so it is the caller's first step.
 */
export function windowsGitBashCandidates({ env = process.env, gitExecPath = null } = {}) {
  const candidates = [];
  const add = (root, source) => {
    for (const relative of GIT_BASH_RELATIVE_PATHS) {
      candidates.push({ file: path.win32.join(root, ...relative), source });
    }
  };

  if (gitExecPath !== null && gitExecPath.trim() !== "") {
    let directory = path.win32.normalize(gitExecPath.trim());
    for (let level = 0; level < GIT_EXEC_PATH_ANCESTORS; level += 1) {
      add(directory, `git --exec-path (${gitExecPath.trim()})`);
      const parent = path.win32.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  for (const { variable, subdirectory } of GIT_INSTALL_ROOTS) {
    const base = environmentValue(env, variable);
    if (base === undefined) continue;
    add(path.win32.join(base, subdirectory), `%${variable}%\\${subdirectory}`);
  }

  return candidates;
}

/**
 * The shell that will run `bridge/build.sh`, or a sentence a developer can act
 * on.
 *
 * Returns `{ kind: "ok", command, source }` - `command` is what to spawn, and
 * `source` says why that one - or `{ kind: "refused", message }`. Never a
 * silent fallback to PATH `bash` on Windows: that is the defect this function
 * exists for.
 *
 * `platform`, `env`, `gitExecPath` and `fileExists` are injectable so the
 * Windows table can be exercised from any machine; production callers pass
 * nothing.
 */
export function resolveBuildShell({
  platform = process.platform,
  env = process.env,
  gitExecPath = platform === "win32" ? detectGitExecPath() : null,
  fileExists = isExistingFile,
} = {}) {
  if (platform !== "win32") {
    return { kind: "ok", command: "bash", source: "PATH" };
  }

  const override = environmentValue(env, GIT_BASH_OVERRIDE_ENV);
  if (override !== undefined) {
    const file = override.trim();
    if (isWindowsSystemBash(file)) {
      return {
        kind: "refused",
        message:
          `${GIT_BASH_OVERRIDE_ENV} points at '${file}', which is the Windows WSL launcher, `
          + "not a Git Bash.\n"
          + "    That shell runs bridge/build.sh inside a Linux distribution, where the "
          + "Windows paths and the pinned Go toolchain this build needs do not exist.\n"
          + `    Point ${GIT_BASH_OVERRIDE_ENV} at a Git for Windows bash.exe `
          + "(for example C:\\Program Files\\Git\\bin\\bash.exe), or unset it and let this "
          + "build find one; see vex-app/DEV.md.",
      };
    }
    if (!fileExists(file)) {
      return {
        kind: "refused",
        message:
          `${GIT_BASH_OVERRIDE_ENV} is set to '${file}', and there is no file there.\n`
          + "    An explicit override is not a hint: this build will not quietly run a "
          + "different shell than the one it was told to use.\n"
          + `    Correct ${GIT_BASH_OVERRIDE_ENV} or unset it to search the Git for Windows `
          + "install roots; see vex-app/DEV.md.",
      };
    }
    return { kind: "ok", command: file, source: GIT_BASH_OVERRIDE_ENV };
  }

  const candidates = windowsGitBashCandidates({ env, gitExecPath });
  for (const candidate of candidates) {
    if (isWindowsSystemBash(candidate.file)) continue;
    if (fileExists(candidate.file)) {
      return { kind: "ok", command: candidate.file, source: candidate.source };
    }
  }

  const probed =
    candidates.length === 0
      ? "    Nothing could be probed: no 'git' answered --exec-path and neither "
        + "%ProgramFiles% nor %LOCALAPPDATA% is set.\n"
      : candidates.map((candidate) => `    probed ${candidate.file}\n`).join("");
  return {
    kind: "refused",
    message:
      "no Git Bash on this Windows machine, so the Vex Studio bridge cannot be built.\n"
      + `    ${BRIDGE_BUILD_SCRIPT} is a bash script and Windows has no bash of its own: `
      + "the System32 'bash.exe' that PATH offers is the WSL launcher, which runs the build "
      + "inside a Linux distribution and is deliberately NOT used.\n"
      + probed
      + "    Install Git for Windows (https://git-scm.com/download/win), which ships Git "
      + `Bash, or set ${GIT_BASH_OVERRIDE_ENV} to an existing bash.exe; see vex-app/DEV.md.`,
  };
}

/**
 * `bridge/build.sh`'s path as the resolved shell should receive it.
 *
 * Git Bash is an MSYS2 program: it accepts a drive-letter path with forward
 * slashes, while a backslash path reaches the script's own `dirname`/`cd` as
 * escape sequences. On POSIX the path is already correct and is returned
 * unchanged.
 */
export function buildScriptArgument(repoRoot, platform = process.platform) {
  if (platform === "win32") {
    // `path.win32` explicitly, so the string this produces is the same one a
    // Windows host produces and the table test can assert it from anywhere.
    return path.win32.join(repoRoot, BRIDGE_BUILD_SCRIPT).split(path.win32.sep).join("/");
  }
  return path.join(repoRoot, BRIDGE_BUILD_SCRIPT);
}

/**
 * Is `bridge/dist/<goos>-<goarch>/` the build these sources and this toolchain
 * produce?
 *
 * Returns `{ kind: "fresh", artifacts, ... }` or `{ kind: "stale", reason }`
 * where the reason names the specific thing that did not match, so a caller can
 * print it rather than "rebuilding, because reasons". `artifacts` is one entry
 * per binary the table lists for this triple, in table order, so a caller can
 * report each by name.
 */
export function evaluateBridgeFreshness({ repoRoot, goos, goarch, goVersion, sourcesDigest }) {
  const digest = sourcesDigest ?? hashBridgeSources(repoRoot);
  const stamp = freshnessStamp({ sourcesDigest: digest, goos, goarch, goVersion });
  const expected = artifactsFor(goos, goarch);
  const artifacts = expected.map((artifact) => ({
    name: artifact.name,
    file: builtArtifactPath(repoRoot, artifact, goos, goarch),
  }));

  const manifest = readManifest(repoRoot, goos, goarch);
  if (manifest === null) {
    return { kind: "stale", reason: "no build manifest beside the binaries", stamp, artifacts };
  }
  if (manifest.stamp !== stamp) {
    const changed =
      manifest.goVersion !== goVersion
        ? `the toolchain changed (built with ${manifest.goVersion}, now ${goVersion})`
        : manifest.sourcesDigest !== digest
          ? "the bridge sources changed"
          : "the recorded build inputs no longer match";
    return { kind: "stale", reason: changed, stamp, artifacts };
  }

  const recorded = manifest.artifacts;
  if (recorded === null || typeof recorded !== "object") {
    return {
      kind: "stale",
      reason: "the build manifest records no per-artifact digests",
      stamp,
      artifacts,
    };
  }

  for (const entry of artifacts) {
    const expectedDigest = recorded[entry.name];
    if (expectedDigest === undefined || typeof expectedDigest.sha256 !== "string") {
      return {
        kind: "stale",
        reason: `the build manifest records no digest for ${entry.name}`,
        stamp,
        artifacts,
      };
    }
    const onDisk = hashFile(entry.file);
    if (onDisk === null) {
      return { kind: "stale", reason: `${entry.name} is missing`, stamp, artifacts };
    }
    if (onDisk !== expectedDigest.sha256) {
      return {
        kind: "stale",
        reason: `${entry.name} on disk is not the one the manifest recorded`,
        stamp,
        artifacts,
      };
    }

    // The manifest can only vouch for bytes. Whether those bytes are an
    // executable of the right format and machine is `bridge-artifact.mjs`'s
    // question, and it is asked on every check rather than trusted from a
    // record.
    try {
      assertBridgeArtifact(entry.file, goos, goarch);
    } catch (error) {
      return { kind: "stale", reason: error.message, stamp, artifacts };
    }
  }

  // A file in the output directory that is NOT a table artifact is deliberately
  // not a freshness question. Nothing reads that directory whole: every
  // consumer (this check, staging, doctor, the dev-mode resolver) addresses the
  // artifacts BY NAME from the table, and the staging directory that
  // `extraResources` copies is cleared and written from the same table. A
  // refusal here would guard no package path, and it would loop on macOS,
  // where Finder recreates `.DS_Store` in any folder a developer has open.
  return { kind: "fresh", stamp, artifacts, manifest };
}
