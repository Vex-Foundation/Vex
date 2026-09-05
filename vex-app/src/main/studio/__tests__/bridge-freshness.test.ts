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
  buildScriptArgument,
  evaluateBridgeFreshness,
  freshnessStamp,
  hashBridgeSources,
  hostGoTarget,
  isWindowsSystemBash,
  readManifest,
  requiredGoVersion,
  resolveBuildShell,
  resolveGoToolchain,
  windowsGitBashCandidates,
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

/**
 * WHICH `bash` RUNS `bridge/build.sh` ON WINDOWS?
 *
 * The risk here is not a build that fails loudly. It is a build handed to the
 * WRONG shell: `%SystemRoot%\System32\bash.exe` exists on every Windows box
 * with WSL enabled and is ahead of Git for Windows on PATH, so a PATH lookup
 * runs the bridge build inside a Linux distribution with Windows paths and a
 * toolchain this module never vouched for. MEASURED on the owner's machine
 * (2026-09-04). None of that is observable from a green Linux suite, so the
 * resolver takes its platform, environment, `git --exec-path` answer and
 * existence probe as INPUTS and the table below drives real Windows layouts
 * from this machine.
 *
 * The reference is VS Code's `src/vs/base/node/powershell.ts`: ordered
 * explicit candidates, each labelled with its source, first existing one wins.
 */

const SYSTEM32_BASH = "C:\\Windows\\System32\\bash.exe";
const PROGRAM_FILES_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PROGRAM_FILES_GIT_USR_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
const LOCAL_APPDATA_GIT_BASH =
  "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
const PORTABLE_GIT_BASH = "D:\\tools\\Git\\bin\\bash.exe";

const WINDOWS_ENV = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
} as const;

function filesystem(...files: readonly string[]): (file: string) => boolean {
  const present = new Set(files);
  return (file) => present.has(file);
}

describe("the shell that runs bridge/build.sh", () => {
  it("uses PATH bash off Windows, where PATH bash is the right answer", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(resolveBuildShell({ platform, env: {}, fileExists: () => false })).toEqual({
        kind: "ok",
        command: "bash",
        source: "PATH",
      });
    }
  });

  const table: readonly {
    readonly name: string;
    readonly env: Record<string, string>;
    readonly gitExecPath: string | null;
    readonly files: readonly string[];
    readonly command: string;
    readonly source: string;
  }[] = [
    {
      name: "prefers the Git for Windows install over the WSL launcher on PATH",
      env: { ...WINDOWS_ENV },
      gitExecPath: null,
      files: [SYSTEM32_BASH, PROGRAM_FILES_GIT_BASH],
      command: PROGRAM_FILES_GIT_BASH,
      source: "%ProgramFiles%\\Git",
    },
    {
      name: "falls back to usr\\bin\\bash.exe when the install has no bin\\bash.exe",
      env: { ...WINDOWS_ENV },
      gitExecPath: null,
      files: [SYSTEM32_BASH, PROGRAM_FILES_GIT_USR_BASH],
      command: PROGRAM_FILES_GIT_USR_BASH,
      source: "%ProgramFiles%\\Git",
    },
    {
      name: "finds the per-user install under %LOCALAPPDATA%",
      env: { ...WINDOWS_ENV },
      gitExecPath: null,
      files: [SYSTEM32_BASH, LOCAL_APPDATA_GIT_BASH],
      command: LOCAL_APPDATA_GIT_BASH,
      source: "%LOCALAPPDATA%\\Programs\\Git",
    },
    {
      name: "walks up from git --exec-path to a portable install in neither default root",
      env: { ...WINDOWS_ENV },
      gitExecPath: "D:/tools/Git/mingw64/libexec/git-core",
      files: [SYSTEM32_BASH, PORTABLE_GIT_BASH],
      command: PORTABLE_GIT_BASH,
      source: "git --exec-path (D:/tools/Git/mingw64/libexec/git-core)",
    },
    {
      name: "asks the Git that is actually installed before the default roots",
      env: { ...WINDOWS_ENV },
      gitExecPath: "D:\\tools\\Git\\mingw64\\libexec\\git-core",
      files: [PORTABLE_GIT_BASH, PROGRAM_FILES_GIT_BASH],
      command: PORTABLE_GIT_BASH,
      source: "git --exec-path (D:\\tools\\Git\\mingw64\\libexec\\git-core)",
    },
    {
      name: "reads the environment case-insensitively, as Windows itself does",
      env: { PROGRAMFILES: "C:\\Program Files" },
      gitExecPath: null,
      files: [SYSTEM32_BASH, PROGRAM_FILES_GIT_BASH],
      command: PROGRAM_FILES_GIT_BASH,
      source: "%ProgramFiles%\\Git",
    },
    {
      name: "takes VEX_GIT_BASH ahead of every install it could have found",
      env: { ...WINDOWS_ENV, VEX_GIT_BASH: PORTABLE_GIT_BASH },
      gitExecPath: null,
      files: [PORTABLE_GIT_BASH, PROGRAM_FILES_GIT_BASH],
      command: PORTABLE_GIT_BASH,
      source: "VEX_GIT_BASH",
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(
        resolveBuildShell({
          platform: "win32",
          env: row.env,
          gitExecPath: row.gitExecPath,
          fileExists: filesystem(...row.files),
        })
      ).toEqual({ kind: "ok", command: row.command, source: row.source });
    });
  }

  it("never answers a bare 'bash' on Windows, whatever is on PATH", () => {
    const resolutions = table.map((row) =>
      resolveBuildShell({
        platform: "win32",
        env: row.env,
        gitExecPath: row.gitExecPath,
        fileExists: filesystem(...row.files),
      })
    );
    for (const resolution of resolutions) {
      expect(resolution.kind === "ok" ? resolution.command : "").not.toBe("bash");
    }
  });

  it("refuses BY NAME when the machine has no Git Bash at all", () => {
    const resolution = resolveBuildShell({
      platform: "win32",
      env: { ...WINDOWS_ENV },
      gitExecPath: null,
      // WSL's launcher is present and is deliberately not a candidate.
      fileExists: filesystem(SYSTEM32_BASH),
    });
    expect(resolution.kind).toBe("refused");
    const message = resolution.kind === "refused" ? resolution.message : "";
    expect(message).toContain("no Git Bash");
    expect(message).toContain("WSL launcher");
    expect(message).toContain(PROGRAM_FILES_GIT_BASH);
    expect(message).toContain(LOCAL_APPDATA_GIT_BASH);
    expect(message).toContain("git-scm.com/download/win");
    expect(message).toContain("VEX_GIT_BASH");
    expect(message).toContain("vex-app/DEV.md");
  });

  it("says what it could not even probe when the environment is empty too", () => {
    const resolution = resolveBuildShell({
      platform: "win32",
      env: {},
      gitExecPath: null,
      fileExists: filesystem(),
    });
    expect(resolution.kind).toBe("refused");
    const message = resolution.kind === "refused" ? resolution.message : "";
    expect(message).toContain("Nothing could be probed");
  });

  it("refuses an override that names a file that is not there, instead of guessing", () => {
    const resolution = resolveBuildShell({
      platform: "win32",
      env: { ...WINDOWS_ENV, VEX_GIT_BASH: "D:\\gone\\bash.exe" },
      gitExecPath: null,
      // A perfectly good Git Bash exists; the override still wins the refusal.
      fileExists: filesystem(PROGRAM_FILES_GIT_BASH),
    });
    expect(resolution.kind).toBe("refused");
    const message = resolution.kind === "refused" ? resolution.message : "";
    expect(message).toContain("VEX_GIT_BASH");
    expect(message).toContain("D:\\gone\\bash.exe");
    expect(message).toContain("no file there");
  });

  it("refuses an override that points at the WSL launcher", () => {
    const resolution = resolveBuildShell({
      platform: "win32",
      env: { ...WINDOWS_ENV, VEX_GIT_BASH: SYSTEM32_BASH },
      gitExecPath: null,
      fileExists: filesystem(SYSTEM32_BASH, PROGRAM_FILES_GIT_BASH),
    });
    expect(resolution.kind).toBe("refused");
    const message = resolution.kind === "refused" ? resolution.message : "";
    expect(message).toContain("WSL launcher");
    expect(message).toContain(SYSTEM32_BASH);
  });

  it("recognises the WSL launcher wherever Windows is installed", () => {
    expect(isWindowsSystemBash(SYSTEM32_BASH)).toBe(true);
    expect(isWindowsSystemBash("D:\\Windows\\SysWOW64\\bash.exe")).toBe(true);
    expect(isWindowsSystemBash("c:\\windows\\system32\\BASH.EXE")).toBe(true);
    expect(isWindowsSystemBash(PROGRAM_FILES_GIT_BASH)).toBe(false);
    expect(isWindowsSystemBash(PORTABLE_GIT_BASH)).toBe(false);
  });

  it("never offers a System32 candidate, whatever git --exec-path answers", () => {
    const candidates = windowsGitBashCandidates({
      env: { ...WINDOWS_ENV },
      gitExecPath: "C:\\Windows\\System32\\Git\\mingw64\\libexec\\git-core",
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(isWindowsSystemBash(candidate.file)).toBe(false);
    }
  });

  it("hands Git Bash a path it can actually open", () => {
    expect(buildScriptArgument("C:\\src\\Vex", "win32")).toBe("C:/src/Vex/bridge/build.sh");
    expect(buildScriptArgument("/home/dev/Vex", "linux")).toBe(
      path.join("/home/dev/Vex", BRIDGE_BUILD_SCRIPT)
    );
  });
});
