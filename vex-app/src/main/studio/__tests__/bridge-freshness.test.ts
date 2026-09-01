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

  it("records the artifact digest and the toolchain that produced it", () => {
    const root = makeFakeRepo();
    build(root);
    const manifest = readManifest(root, "linux", "amd64");
    expect(manifest?.goVersion).toBe(GO_VERSION);
    expect(manifest?.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest?.sourcesDigest).toBe(hashBridgeSources(root));
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
