/**
 * The dev-path answer to "is the built bridge still the one these sources
 * produce?".
 *
 * The risk this suite exists for is a WRONG YES: a `pnpm dev` that skips the
 * Go build while `bridge/dist/<triple>/vex-mcp` is stale, missing, replaced or
 * built by a different toolchain, because that is indistinguishable at run
 * time from a bridge that works - the installer just writes nothing and says
 * "unavailable".
 *
 * The experiments run against a SYNTHETIC repository under the OS temp
 * directory, so they are deterministic, need no Go toolchain, and cannot be
 * satisfied by whatever happens to sit in this checkout's `bridge/dist`. The
 * one assertion aimed at the real tree is the Go pin, which has a single owner
 * (`bridge/build.sh`) and must not be copied into a second file.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BRIDGE_BUILD_SCRIPT,
  bridgeSourceFiles,
  evaluateBridgeFreshness,
  freshnessStamp,
  hashBridgeSources,
  hostGoTarget,
  readManifest,
  requiredGoVersion,
  resolveGoToolchain,
  writeManifest,
} from "../../../../scripts/bridge-freshness.mjs";

const REAL_REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const GO_VERSION = "go1.27.0";
const OTHER_GO_VERSION = "go1.27.1";

/**
 * A minimal but genuine 64-bit little-endian ELF header for x86-64.
 *
 * `assertBridgeArtifact` reads the file's own header rather than trusting its
 * path, so the fake artifact has to be a real header - which is the point: a
 * text file named `vex-mcp` must not pass.
 */
function fakeLinuxAmd64Binary(payload: string): Buffer {
  const head = Buffer.alloc(64, 0);
  head[0] = 0x7f;
  head.write("ELF", 1, "ascii");
  head[4] = 2; // 64-bit
  head[5] = 1; // little-endian
  head.writeUInt16LE(0x3e, 18); // EM_X86_64
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

/**
 * A minimal but genuine PE header for x86-64, for the Windows triples - the
 * only ones that carry a SECOND artifact.
 */
function fakeWindowsAmd64Binary(payload: string): Buffer {
  const head = Buffer.alloc(128, 0);
  head.write("MZ", 0, "ascii");
  head.writeUInt32LE(0x40, 0x3c); // e_lfanew
  head.write("PE\0\0", 0x40, "ascii");
  head.writeUInt16LE(0x8664, 0x44); // IMAGE_FILE_MACHINE_AMD64
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

const temporaryRoots: string[] = [];

function makeFakeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-bridge-freshness-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, "bridge", "cmd", "vex-mcp"), { recursive: true });
  mkdirSync(path.join(root, "bridge", "internal", "relay"), { recursive: true });
  writeFileSync(
    path.join(root, "bridge", "build.sh"),
    `#!/usr/bin/env bash\nreadonly REQUIRED_GO_VERSION="${GO_VERSION}"\n`
  );
  writeFileSync(path.join(root, "bridge", "go.mod"), "module vex-mcp\n\ngo 1.27\n");
  writeFileSync(path.join(root, "bridge", "cmd", "vex-mcp", "main.go"), "package main\n");
  writeFileSync(path.join(root, "bridge", "internal", "relay", "relay.go"), "package relay\n");
  return root;
}

function writeArtifact(root: string, payload: string): string {
  const dir = path.join(root, "bridge", "dist", "linux-amd64");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "vex-mcp");
  writeFileSync(file, fakeLinuxAmd64Binary(payload));
  return file;
}

function build(root: string, payload = "compiled bytes"): void {
  writeArtifact(root, payload);
  writeManifest(root, {
    goos: "linux",
    goarch: "amd64",
    goVersion: GO_VERSION,
    sourcesDigest: hashBridgeSources(root),
  });
}

function freshness(root: string, goVersion = GO_VERSION) {
  return evaluateBridgeFreshness({ repoRoot: root, goos: "linux", goarch: "amd64", goVersion });
}

// ── The Windows triple, the only one that carries a second artifact ─────────

const WINDOWS_DIST = ["bridge", "dist", "windows-amd64"] as const;

function windowsFile(root: string, name: string): string {
  return path.join(root, ...WINDOWS_DIST, name);
}

/** Write one Windows artifact by name, without touching the other. */
function writeWindowsArtifact(root: string, name: string, payload: string): string {
  const file = windowsFile(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, fakeWindowsAmd64Binary(payload));
  return file;
}

function buildWindows(root: string, mcp = "mcp bytes", front = "front bytes"): void {
  writeWindowsArtifact(root, "vex-mcp.exe", mcp);
  writeWindowsArtifact(root, "vex-pipe-front.exe", front);
  writeManifest(root, {
    goos: "windows",
    goarch: "amd64",
    goVersion: GO_VERSION,
    sourcesDigest: hashBridgeSources(root),
  });
}

function windowsFreshness(root: string) {
  return evaluateBridgeFreshness({
    repoRoot: root,
    goos: "windows",
    goarch: "amd64",
    goVersion: GO_VERSION,
  });
}

afterEach(() => {
  // The synthetic repos are disposable; leaving them would accumulate a few MB
  // per run under $TMPDIR across a watch session.
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the Go pin has one owner", () => {
  it("reads the required version out of bridge/build.sh rather than restating it", () => {
    const script = readFileSync(path.join(REAL_REPO_ROOT, BRIDGE_BUILD_SCRIPT), "utf8");
    const declared = /^readonly REQUIRED_GO_VERSION="([^"]+)"/m.exec(script);
    expect(declared).not.toBeNull();
    expect(requiredGoVersion(REAL_REPO_ROOT)).toBe(declared?.[1]);
  });
});

describe("the build inputs", () => {
  it("collects the Go sources, go.mod and build.sh, and never the output directory", () => {
    const root = makeFakeRepo();
    writeArtifact(root, "not an input");
    expect(bridgeSourceFiles(root)).toEqual([
      "bridge/build.sh",
      "bridge/cmd/vex-mcp/main.go",
      "bridge/go.mod",
      "bridge/internal/relay/relay.go",
    ]);
  });

  it("digests content, not mtime, so a rebase or fresh clone does not force a rebuild", () => {
    const root = makeFakeRepo();
    const before = hashBridgeSources(root);
    const touched = path.join(root, "bridge", "cmd", "vex-mcp", "main.go");
    const future = new Date(Date.now() + 60_000);
    utimesSync(touched, future, future);
    expect(hashBridgeSources(root)).toBe(before);
  });

  it("changes when any Go source changes", () => {
    const root = makeFakeRepo();
    const before = hashBridgeSources(root);
    writeFileSync(
      path.join(root, "bridge", "internal", "relay", "relay.go"),
      "package relay\n\nfunc Added() {}\n"
    );
    expect(hashBridgeSources(root)).not.toBe(before);
  });

  it("changes when build.sh changes, because its flags are part of the output", () => {
    const root = makeFakeRepo();
    const before = hashBridgeSources(root);
    const script = path.join(root, "bridge", "build.sh");
    writeFileSync(script, `${readFileSync(script, "utf8")}readonly LDFLAGS="-s"\n`);
    expect(hashBridgeSources(root)).not.toBe(before);
  });
});

describe("the freshness stamp", () => {
  it("separates targets, so one triple's manifest cannot vouch for another", () => {
    const shared = { sourcesDigest: "abc", goVersion: GO_VERSION } as const;
    expect(freshnessStamp({ ...shared, goos: "linux", goarch: "amd64" })).not.toBe(
      freshnessStamp({ ...shared, goos: "linux", goarch: "arm64" })
    );
    expect(freshnessStamp({ ...shared, goos: "linux", goarch: "amd64" })).not.toBe(
      freshnessStamp({ ...shared, goos: "darwin", goarch: "amd64" })
    );
  });

  it("separates toolchains, because the pin is exact and not a minimum", () => {
    const shared = { sourcesDigest: "abc", goos: "linux", goarch: "amd64" } as const;
    expect(freshnessStamp({ ...shared, goVersion: GO_VERSION })).not.toBe(
      freshnessStamp({ ...shared, goVersion: OTHER_GO_VERSION })
    );
  });
});

describe("evaluating what is on disk", () => {
  it("is stale when nothing has been built", () => {
    const root = makeFakeRepo();
    const verdict = freshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("no build manifest");
  });

  it("is fresh immediately after a build, and stays fresh on a second check", () => {
    const root = makeFakeRepo();
    build(root);
    expect(freshness(root).kind).toBe("fresh");
    expect(freshness(root).kind).toBe("fresh");
  });

  it("records a digest PER ARTIFACT, and the toolchain that produced them", () => {
    const root = makeFakeRepo();
    build(root);
    const manifest = readManifest(root, "linux", "amd64");
    expect(manifest?.goVersion).toBe(GO_VERSION);
    expect(manifest?.sourcesDigest).toBe(hashBridgeSources(root));
    // linux carries one artifact; the map is keyed by name either way, so the
    // record's shape does not depend on how many the triple happens to have.
    expect(Object.keys(manifest?.artifacts ?? {})).toEqual(["vex-mcp"]);
    expect(manifest?.artifacts?.["vex-mcp"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest?.artifacts?.["vex-mcp"]?.bytes).toBeGreaterThan(0);
  });

  it("is stale after a source change", () => {
    const root = makeFakeRepo();
    build(root);
    writeFileSync(path.join(root, "bridge", "cmd", "vex-mcp", "main.go"), "package main\n// v2\n");
    const verdict = freshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("sources changed");
  });

  it("is stale when the toolchain changed, and names both versions", () => {
    const root = makeFakeRepo();
    build(root);
    const verdict = freshness(root, OTHER_GO_VERSION);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain(GO_VERSION);
    expect(verdict.kind === "stale" && verdict.reason).toContain(OTHER_GO_VERSION);
  });

  it("is stale when the binary is gone, even though the manifest is still there", () => {
    const root = makeFakeRepo();
    build(root);
    rmSync(path.join(root, "bridge", "dist", "linux-amd64", "vex-mcp"));
    const verdict = freshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("missing");
  });

  it("is stale when the binary was replaced behind the manifest's back", () => {
    const root = makeFakeRepo();
    build(root);
    writeArtifact(root, "different bytes");
    const verdict = freshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("not the one the manifest");
  });

  it("is stale when the recorded bytes are not an executable for this target", () => {
    const root = makeFakeRepo();
    const file = path.join(root, "bridge", "dist", "linux-amd64", "vex-mcp");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.alloc(128, 0x41));
    writeManifest(root, {
      goos: "linux",
      goarch: "amd64",
      goVersion: GO_VERSION,
      sourcesDigest: hashBridgeSources(root),
    });
    const verdict = freshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("not an ELF");
  });

  it("is stale when the manifest is corrupt rather than treating it as a failure", () => {
    const root = makeFakeRepo();
    build(root);
    writeFileSync(
      path.join(root, "bridge", "dist", "linux-amd64", "build-manifest.json"),
      "{ truncated"
    );
    expect(freshness(root).kind).toBe("stale");
  });
});

/**
 * The regression this block exists for, stated plainly: before the artifact
 * table, the manifest carried ONE digest. On a Windows triple that meant a
 * missing, replaced or foreign `vex-pipe-front.exe` sitting beside a correct
 * `vex-mcp.exe` read as FRESH forever - the build was skipped, the staging
 * preflight copied whatever was there, and nothing in the chain ever hashed it.
 */
describe("a triple that carries a SECOND artifact", () => {
  it("is fresh only when BOTH binaries are the ones the manifest recorded", () => {
    const root = makeFakeRepo();
    buildWindows(root);
    const verdict = windowsFreshness(root);
    expect(verdict.kind).toBe("fresh");
    expect(verdict.artifacts.map((entry) => entry.name)).toEqual(["vex-mcp", "vex-pipe-front"]);
  });

  it("records a digest for each artifact under its own name", () => {
    const root = makeFakeRepo();
    buildWindows(root);
    const manifest = readManifest(root, "windows", "amd64");
    expect(Object.keys(manifest?.artifacts ?? {}).sort()).toEqual(["vex-mcp", "vex-pipe-front"]);
    expect(manifest?.artifacts?.["vex-mcp"]?.sha256).not.toBe(
      manifest?.artifacts?.["vex-pipe-front"]?.sha256,
    );
  });

  it("is stale, by name, when the second artifact is MISSING", () => {
    const root = makeFakeRepo();
    buildWindows(root);
    rmSync(windowsFile(root, "vex-pipe-front.exe"));
    const verdict = windowsFreshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toBe("vex-pipe-front is missing");
  });

  it("is stale, by name, when the second artifact is REPLACED behind the manifest", () => {
    const root = makeFakeRepo();
    buildWindows(root);
    writeWindowsArtifact(root, "vex-pipe-front.exe", "someone else's bytes");
    const verdict = windowsFreshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("vex-pipe-front on disk is not");
  });

  it("is stale when the second artifact is not an executable for this target", () => {
    const root = makeFakeRepo();
    writeWindowsArtifact(root, "vex-mcp.exe", "mcp bytes");
    const file = windowsFile(root, "vex-pipe-front.exe");
    writeFileSync(file, Buffer.alloc(128, 0x41));
    writeManifest(root, {
      goos: "windows",
      goarch: "amd64",
      goVersion: GO_VERSION,
      sourcesDigest: hashBridgeSources(root),
    });
    const verdict = windowsFreshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("not an ELF, Mach-O or PE");
  });

  it("refuses to record a manifest at all when an artifact is missing after a build", () => {
    // The alternative is a manifest that vouches for an absence, which is
    // exactly how a missing binary becomes permanently "fresh".
    const root = makeFakeRepo();
    writeWindowsArtifact(root, "vex-mcp.exe", "mcp bytes");
    expect(() =>
      writeManifest(root, {
        goos: "windows",
        goarch: "amd64",
        goVersion: GO_VERSION,
        sourcesDigest: hashBridgeSources(root),
      }),
    ).toThrow(/vex-pipe-front\.exe is missing after the build reported success/);
  });

  it("ignores a file in the output directory that is not a table artifact", () => {
    // Nothing reads that directory whole: every consumer addresses the
    // artifacts by name from the table, and the staging directory that ships
    // is cleared and written from the same table. Refusing here would guard no
    // package path and would loop on macOS, where Finder recreates `.DS_Store`
    // in any folder a developer has open.
    const root = makeFakeRepo();
    build(root);
    writeFileSync(path.join(root, "bridge", "dist", "linux-amd64", ".DS_Store"), "finder");
    expect(freshness(root).kind).toBe("fresh");
  });
});

describe("the manifest format", () => {
  it("reads a pre-v2 record as STALE rather than as fresh or as a crash", () => {
    // The v1 shape carried a single `artifactDigest` and no `artifacts` map.
    // Compatibility is one-way by construction: the manifest version is an
    // input to the stamp, so an old record cannot match a new one.
    const root = makeFakeRepo();
    build(root);
    const file = path.join(root, "bridge", "dist", "linux-amd64", "build-manifest.json");
    const current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const legacy: Record<string, unknown> = {
      ...current,
      manifestVersion: 1,
      artifactDigest: (current["artifacts"] as Record<string, { sha256: string }>)["vex-mcp"]
        ?.sha256,
      // The v1 stamp, in the v1 encoding: `v1` where a current record says
      // `v2`. This is what makes the incompatibility structural rather than a
      // missing field the reader might have tolerated.
      stamp: createHash("sha256")
        .update(
          `v1\n${String(current["sourcesDigest"])}\nlinux-amd64\n${GO_VERSION}\n`,
          "utf8",
        )
        .digest("hex"),
    };
    delete legacy["artifacts"];
    writeFileSync(file, JSON.stringify(legacy, null, 2));

    const verdict = freshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("build inputs no longer match");
  });

  it("is stale when a same-stamp record somehow carries no per-artifact digests", () => {
    const root = makeFakeRepo();
    build(root);
    const file = path.join(root, "bridge", "dist", "linux-amd64", "build-manifest.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete record["artifacts"];
    writeFileSync(file, JSON.stringify(record, null, 2));

    const verdict = freshness(root);
    expect(verdict.kind).toBe("stale");
    expect(verdict.kind === "stale" && verdict.reason).toContain("no per-artifact digests");
  });
});

describe("the toolchain refusal", () => {
  it("names build.sh, the exact version and DEV.md when go is absent", () => {
    const root = makeFakeRepo();
    const resolution = resolveGoToolchain(root, { kind: "missing" });
    expect(resolution.kind).toBe("refused");
    const message = resolution.kind === "refused" ? resolution.message : "";
    expect(message).toContain("no 'go' on PATH");
    expect(message).toContain(GO_VERSION);
    expect(message).toContain(BRIDGE_BUILD_SCRIPT);
    expect(message).toContain("vex-app/DEV.md");
  });

  it("refuses a different patch release rather than accepting it as good enough", () => {
    const root = makeFakeRepo();
    const resolution = resolveGoToolchain(root, { kind: "ok", version: OTHER_GO_VERSION });
    expect(resolution.kind).toBe("refused");
    const message = resolution.kind === "refused" ? resolution.message : "";
    expect(message).toContain(OTHER_GO_VERSION);
    expect(message).toContain(GO_VERSION);
    expect(message).toContain("exact, not a minimum");
  });

  it("accepts exactly the pinned version", () => {
    const root = makeFakeRepo();
    expect(resolveGoToolchain(root, { kind: "ok", version: GO_VERSION })).toEqual({
      kind: "ok",
      version: GO_VERSION,
    });
  });
});

describe("the host target", () => {
  it("resolves this machine to the triple locateStudioBridge will look for", () => {
    const { goos, goarch } = hostGoTarget("linux", "x64");
    expect(`${goos}-${goarch}`).toBe("linux-amd64");
    expect(hostGoTarget("win32", "arm64")).toEqual({ goos: "windows", goarch: "arm64" });
  });

  it("refuses an unsupported platform or arch BY NAME", () => {
    expect(() => hostGoTarget("freebsd", "x64")).toThrow(/freebsd\/x64/);
    expect(() => hostGoTarget("linux", "ia32")).toThrow(/linux\/ia32/);
  });
});
