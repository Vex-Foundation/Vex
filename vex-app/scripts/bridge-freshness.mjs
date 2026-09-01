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
 *   artifact digest the sha256 of the binary itself, re-read on every check.
 *                   Without it a hand-replaced or half-written `vex-mcp` would
 *                   keep passing because the manifest beside it still matched.
 *
 * The manifest lives in the build output directory (`bridge/dist/` is
 * git-ignored), so it is discarded exactly when the artifact it describes is.
 *
 * THE TOOLCHAIN IS REQUIRED, NOT OPTIONAL. A missing or wrong `go` is answered
 * with a named refusal that points at `bridge/build.sh` and `vex-app/DEV.md`,
 * never with a skip: a silent skip is how a developer ends up debugging an
 * installer that "writes no files" when the real cause is a build that never
 * ran.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  GO_ARCH_BY_ELECTRON_ARCH,
  GOOS_BY_ELECTRON_PLATFORM,
  assertBridgeArtifact,
  builtBridgePath,
} from "./bridge-artifact.mjs";

/** The build wrapper every packaging and dev path calls. Repo-root relative. */
export const BRIDGE_BUILD_SCRIPT = path.join("bridge", "build.sh");

/** File name of the freshness record, inside the target's output directory. */
export const BRIDGE_MANIFEST_NAME = "build-manifest.json";

/** Bumped when the stamp's inputs or encoding change, so old records go stale. */
const MANIFEST_VERSION = 1;

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

/** Write the record for a target that was just built. */
export function writeManifest(repoRoot, { goos, goarch, goVersion, sourcesDigest }) {
  const artifact = builtBridgePath(repoRoot, goos, goarch);
  const artifactDigest = hashFile(artifact);
  if (artifactDigest === null) {
    throw new Error(`${artifact} is missing after the build reported success`);
  }
  const file = manifestPath(repoRoot, goos, goarch);
  mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    manifestVersion: MANIFEST_VERSION,
    goos,
    goarch,
    goVersion,
    sourcesDigest,
    artifactDigest,
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
 * Is `bridge/dist/<goos>-<goarch>/` the build these sources and this toolchain
 * produce?
 *
 * Returns `{ kind: "fresh", ... }` or `{ kind: "stale", reason }` where the
 * reason names the specific thing that did not match, so a caller can print it
 * rather than "rebuilding, because reasons".
 */
export function evaluateBridgeFreshness({ repoRoot, goos, goarch, goVersion, sourcesDigest }) {
  const digest = sourcesDigest ?? hashBridgeSources(repoRoot);
  const stamp = freshnessStamp({ sourcesDigest: digest, goos, goarch, goVersion });
  const artifact = builtBridgePath(repoRoot, goos, goarch);

  const manifest = readManifest(repoRoot, goos, goarch);
  if (manifest === null) {
    return { kind: "stale", reason: "no build manifest beside the binary", stamp, artifact };
  }
  if (manifest.stamp !== stamp) {
    const changed =
      manifest.goVersion !== goVersion
        ? `the toolchain changed (built with ${manifest.goVersion}, now ${goVersion})`
        : manifest.sourcesDigest !== digest
          ? "the bridge sources changed"
          : "the recorded build inputs no longer match";
    return { kind: "stale", reason: changed, stamp, artifact };
  }

  const artifactDigest = hashFile(artifact);
  if (artifactDigest === null) {
    return { kind: "stale", reason: "the binary is missing", stamp, artifact };
  }
  if (artifactDigest !== manifest.artifactDigest) {
    return {
      kind: "stale",
      reason: "the binary on disk is not the one the manifest recorded",
      stamp,
      artifact,
    };
  }

  // The manifest can only vouch for bytes. Whether those bytes are an
  // executable of the right format and machine is `bridge-artifact.mjs`'s
  // question, and it is asked on every check rather than trusted from a record.
  try {
    assertBridgeArtifact(artifact, goos, goarch);
  } catch (error) {
    return { kind: "stale", reason: error.message, stamp, artifact };
  }

  return { kind: "fresh", stamp, artifact, manifest };
}
