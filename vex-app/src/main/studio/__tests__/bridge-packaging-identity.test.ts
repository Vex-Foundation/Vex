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

import {
  GO_ARCH_BY_ELECTRON_ARCH,
  GOOS_BY_ELECTRON_PLATFORM,
  PACKAGED_BRIDGE_SUBPATH,
  bridgeBinaryName,
  builtBridgePath,
  goTargetFor,
  inspectExecutable,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error - a plain packaging script, deliberately outside the
  // TypeScript program: it runs under bare node in electron-builder's
  // afterPack hook and in CI, where a compile step does not exist.
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
    expect(bridgeBinaryName("windows")).toBe("vex-mcp.exe");
    expect(bridgeBinaryName("darwin")).toBe("vex-mcp");
    expect(bridgeBinaryName("linux")).toBe("vex-mcp");
    expect(builtBridgePath("/repo", "darwin", "arm64")).toBe(
      path.join("/repo", "bridge", "dist", "darwin-arm64", "vex-mcp"),
    );
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
