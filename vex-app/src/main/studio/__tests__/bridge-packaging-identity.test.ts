/**
 * The FROZEN packaging identity for the Vex Studio bridge, and the executable
 * header reader that enforces it.
 *
 * The identity is contract (stage A4c plan, item 5): Electron `x64` -> Go
 * `amd64`, `arm64` -> `arm64`, `mac`/`win`/`linux` -> `darwin`/`windows`/
 * `linux`, packaged at `resources/bridge/vex-mcp` (`.exe` on Windows).
 *
 * Pinned here rather than parsed out of the electron-builder YAML because
 * neither tree has a YAML parser as a DIRECT dependency, and a test that
 * reached for a transitive one would break on a hoisting change rather than on
 * a real regression. What catches a new architecture appearing in a profile is
 * the preflight itself: `goTargetFor` refuses an unmapped value BY NAME and
 * `scripts/stage-bridge.mjs` fails the build rather than packaging a bundle
 * with no bridge in it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { BridgeArtifact, BridgeGoarch, BridgeGoos } from "../../../../scripts/bridge-artifact.mjs";
import {
  BRIDGE_ARTIFACTS,
  BRIDGE_TARGETS,
  GO_ARCH_BY_ELECTRON_ARCH,
  GOOS_BY_ELECTRON_PLATFORM,
  PACKAGED_BRIDGE_SUBPATH,
  artifactBinaryName,
  artifactsFor,
  builtArtifactPath,
  goTargetFor,
  inspectExecutable,
} from "../../../../scripts/bridge-artifact.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "bridge", "build.sh");

/** The union of both electron-builder profiles, frozen with the contract. */
const FROZEN_TARGETS = [
  "darwin-arm64",
  "darwin-amd64",
  "windows-amd64",
  "windows-arm64",
  "linux-amd64",
  "linux-arm64",
];

/**
 * Every triple as a typed pair, so the cross-product test below can call the
 * table's functions without casting a `split()` result back into the domain
 * vocabulary. Asserted against `BRIDGE_TARGETS` itself, so this list cannot
 * silently fall behind the table it enumerates.
 */
const TRIPLES: readonly (readonly [BridgeGoos, BridgeGoarch])[] = [
  ["darwin", "arm64"],
  ["darwin", "amd64"],
  ["windows", "amd64"],
  ["windows", "arm64"],
  ["linux", "amd64"],
  ["linux", "arm64"],
];

/** The artifact with this name, or a failure naming it. */
function artifactNamed(name: string): BridgeArtifact {
  const found = BRIDGE_ARTIFACTS.find((artifact) => artifact.name === name);
  if (found === undefined) throw new Error(`the artifact table has no entry named ${name}`);
  return found;
}

/**
 * The ARTIFACTS block of `bridge/build.sh`, parsed as data.
 *
 * The bash mirror is the ONE place the artifact table is restated, because
 * `build.sh` cannot import an `.mjs` module. Parsing it here is what turns
 * "keep these two in sync" from a comment into a failing test.
 */
function buildScriptArtifacts(): { name: string; cmd: string; targets: string[] }[] {
  const script = readFileSync(BUILD_SCRIPT, "utf8");
  const block = /^ARTIFACTS=\(\n([\s\S]*?)^\)$/m.exec(script);
  expect(block, "bridge/build.sh no longer declares an ARTIFACTS=( ... ) block").not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/^\s*"([^"]+)"\s*$/gm)].map((match) => {
    const [name, cmd, ...targets] = String(match[1]).split(/\s+/);
    return { name: String(name), cmd: String(cmd), targets };
  });
}

describe("the frozen packaging identity", () => {
  it("maps every Electron platform and arch Vex packages, and nothing else", () => {
    expect(GO_ARCH_BY_ELECTRON_ARCH).toEqual({ x64: "amd64", arm64: "arm64" });
    expect(GOOS_BY_ELECTRON_PLATFORM).toEqual({
      darwin: "darwin",
      mac: "darwin",
      win32: "windows",
      win: "windows",
      linux: "linux",
    });
  });

  it("refuses an unmapped platform or arch BY NAME rather than defaulting", () => {
    // This refusal is what turns "a profile gained an architecture" into a
    // failed build instead of a package with no bridge in it.
    expect(() => goTargetFor("linux", "ia32")).toThrow(/unknown packaging architecture "ia32"/);
    expect(() => goTargetFor("solaris", "x64")).toThrow(/unknown packaging platform "solaris"/);
    expect(() => goTargetFor("linux", "universal")).toThrow(/unknown packaging architecture/);
  });

  it("packages at the contract path, with the Windows extension", () => {
    expect(PACKAGED_BRIDGE_SUBPATH).toBe("bridge");
    const mcp = artifactNamed("vex-mcp");
    const front = artifactNamed("vex-pipe-front");
    expect({
      mcpWindows: artifactBinaryName(mcp, "windows"),
      mcpDarwin: artifactBinaryName(mcp, "darwin"),
      mcpLinux: artifactBinaryName(mcp, "linux"),
      frontWindows: artifactBinaryName(front, "windows"),
      mcpBuilt: builtArtifactPath("/repo", mcp, "darwin", "arm64"),
      frontBuilt: builtArtifactPath("/repo", front, "windows", "arm64"),
    }).toEqual({
      mcpWindows: "vex-mcp.exe",
      mcpDarwin: "vex-mcp",
      mcpLinux: "vex-mcp",
      frontWindows: "vex-pipe-front.exe",
      mcpBuilt: path.join("/repo", "bridge", "dist", "darwin-arm64", "vex-mcp"),
      frontBuilt: path.join("/repo", "bridge", "dist", "windows-arm64", "vex-pipe-front.exe"),
    });
  });

  it("the build wrapper builds exactly the frozen target union", () => {
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    const block = /^TARGETS=\(\n([\s\S]*?)^\)$/m.exec(script);
    expect(block).not.toBeNull();
    const listed = [...(block?.[1] ?? "").matchAll(/"(\w+) (\w+)"/g)].map(
      (match) => `${String(match[1])}-${String(match[2])}`,
    );
    expect(new Set(listed)).toEqual(new Set(FROZEN_TARGETS));
  });

  it("pins the toolchain EXACTLY, and refuses to download one", () => {
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    // go.mod's `go` directive is only a FLOOR, so exactness lives in the
    // wrapper. Both halves are required: the version comparison alone would
    // still let Go fetch a matching toolchain over the network.
    expect(script).toContain('readonly REQUIRED_GO_VERSION="go1.27.0"');
    expect(script).toContain("GOTOOLCHAIN=local go env GOVERSION");
    expect(script).toContain("CGO_ENABLED=0");
    expect(script).toContain("GOAMD64=v1");
    expect(script).toContain("GOARM64=v8.0");
    expect(script).toContain("-trimpath");
    expect(script).toContain("-buildvcs=false");
  });
});

describe("the artifact table", () => {
  it("names, for EVERY triple, exactly the binaries that triple carries", () => {
    // One table-driven assertion over the whole cross-product rather than a
    // test per triple: the risk is a triple that quietly gains or loses an
    // artifact, and a per-triple test can only fail for the triples someone
    // remembered to write.
    expect(TRIPLES.map(([goos, goarch]) => `${goos}-${goarch}`)).toEqual([...BRIDGE_TARGETS]);
    const surface = Object.fromEntries(
      TRIPLES.map(([goos, goarch]) => [
        `${goos}-${goarch}`,
        artifactsFor(goos, goarch).map((artifact) => artifactBinaryName(artifact, goos)),
      ]),
    );
    expect(surface).toEqual({
      "darwin-arm64": ["vex-mcp"],
      "darwin-amd64": ["vex-mcp"],
      "windows-amd64": ["vex-mcp.exe", "vex-pipe-front.exe"],
      "windows-arm64": ["vex-mcp.exe", "vex-pipe-front.exe"],
      "linux-amd64": ["vex-mcp"],
      "linux-arm64": ["vex-mcp"],
    });
  });

  it("refuses a triple it builds nothing for, rather than returning an empty set", () => {
    // An empty list is what every consumer would read as "all zero artifacts
    // verified" - a gate that passes vacuously is worse than no gate.
    expect(() => artifactsFor("freebsd", "amd64")).toThrow(/builds nothing for freebsd-amd64/);
    expect(() => artifactsFor("windows", "riscv64")).toThrow(/builds nothing for windows-riscv64/);
  });

  it("stays byte-for-byte in sync with the bash mirror in bridge/build.sh", () => {
    // The drift this catches is silent and expensive: build.sh emitting one
    // set of binaries while every Node-side gate verifies another.
    expect(buildScriptArtifacts()).toEqual(
      BRIDGE_ARTIFACTS.map((artifact) => ({
        name: artifact.name,
        cmd: artifact.cmd,
        targets: [...artifact.targets],
      })),
    );
  });

  it("clears the target directory before writing, so an artifact dropped from the table does not linger", () => {
    // Without the clear, an artifact that stops being built for a triple, or
    // one left behind by an older checkout, would sit beside the current
    // outputs until someone deleted it by hand.
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    expect(script).toMatch(/rm -rf "\$out_dir"\s*\n\s*mkdir -p "\$out_dir"/);
  });
});

describe("the executable header reader", () => {
  it("refuses a file that is not an executable at all", () => {
    expect(() => inspectExecutable(path.join(REPO_ROOT, "package.json"))).toThrow(
      /not an ELF, Mach-O or PE executable/,
    );
  });

  it("refuses a missing file rather than treating absence as a pass", () => {
    expect(() =>
      inspectExecutable(path.join(REPO_ROOT, "bridge", "dist", "nope", "vex-mcp")),
    ).toThrow(/missing:/);
  });
});
