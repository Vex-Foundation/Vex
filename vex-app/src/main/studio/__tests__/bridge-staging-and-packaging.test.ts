/**
 * THE TWO GATES BETWEEN A BUILT BINARY AND A SIGNED PACKAGE, over a synthetic
 * tree that contains a SECOND artifact.
 *
 * `scripts/stage-bridge.mjs` copies what electron-builder will package;
 * `build/afterPack.mjs` re-inspects what it actually packaged, before fuses and
 * before codesigning. Both used to know exactly one file name. The failure this
 * suite is aimed at is the quiet one: a Windows package that ships `vex-mcp.exe`
 * alone, passes every gate, and fails only when main tries to spawn a pipe
 * front that is not in the bundle.
 *
 * The binaries here are FAKE - real PE, ELF and Mach-O headers over a few bytes
 * of payload - and that is deliberate rather than a shortcut. Both gates read
 * each file's OWN header, so a header is exactly what they can be proven
 * against, and a synthetic tree is the only way to exercise the Windows and
 * macOS shapes from a Linux runner. What a fake cannot prove - that the Go
 * build actually emits these names at these paths - is proven instead by the
 * `bridge/build.sh` mirror-drift test in bridge-packaging-identity.test.ts.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { verifyPackagedBridge } from "../../../../build/afterPack.mjs";

const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "..", "..", "scripts");

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function peAmd64(payload: string): Buffer {
  const head = Buffer.alloc(128, 0);
  head.write("MZ", 0, "ascii");
  head.writeUInt32LE(0x40, 0x3c); // e_lfanew
  head.write("PE\0\0", 0x40, "ascii");
  head.writeUInt16LE(0x8664, 0x44); // IMAGE_FILE_MACHINE_AMD64
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

function elfAmd64(payload: string): Buffer {
  const head = Buffer.alloc(64, 0);
  head[0] = 0x7f;
  head.write("ELF", 1, "ascii");
  head[4] = 2; // 64-bit
  head[5] = 1; // little-endian
  head.writeUInt16LE(0x3e, 18); // EM_X86_64
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

function machoArm64(payload: string): Buffer {
  const head = Buffer.alloc(64, 0);
  head[0] = 0xcf;
  head[1] = 0xfa;
  head[2] = 0xed;
  head[3] = 0xfe;
  head.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

function writeBinary(file: string, bytes: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  chmodSync(file, 0o755);
}

// ── stage-bridge ────────────────────────────────────────────────────────────

interface StagedArtifact {
  readonly name: string;
  readonly source: string;
  readonly destination: string;
}

/**
 * The REAL `stage-bridge.mjs`, loaded so that its own `import.meta.url` sits
 * inside a synthetic tree.
 *
 * The script resolves the repository root from its own location, on purpose:
 * that is what makes it correct when called from any working directory. Rather
 * than adding a test-only root parameter to the production module, the module
 * (and the artifact table it imports) is copied into a temporary
 * `<root>/vex-app/scripts/` and imported from there, so the code under test is
 * byte-for-byte the shipped code.
 */
async function loadStageBridge(
  repoRoot: string,
): Promise<(platform: string, arch: string) => StagedArtifact[]> {
  const scriptsDir = path.join(repoRoot, "vex-app", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const name of ["stage-bridge.mjs", "bridge-artifact.mjs"]) {
    writeFileSync(path.join(scriptsDir, name), readFileSync(path.join(SCRIPTS_DIR, name), "utf8"));
  }
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(path.join(scriptsDir, "stage-bridge.mjs")).href
  )) as { stageBridge: (platform: string, arch: string) => StagedArtifact[] };
  return module.stageBridge;
}

function stagedDir(repoRoot: string, electronArch: string): string {
  return path.join(repoRoot, "vex-app", "resources", `bridge-${electronArch}`);
}

describe("staging every artifact a target carries", () => {
  it("stages BOTH Windows binaries into one directory, and only those", async () => {
    const repoRoot = temporaryRoot("vex-stage-win-");
    const dist = path.join(repoRoot, "bridge", "dist", "windows-amd64");
    writeBinary(path.join(dist, "vex-mcp.exe"), peAmd64("mcp"));
    writeBinary(path.join(dist, "vex-pipe-front.exe"), peAmd64("front"));

    const stageBridge = await loadStageBridge(repoRoot);
    const staged = stageBridge("win", "x64");

    expect(staged.map((entry) => entry.name)).toEqual(["vex-mcp", "vex-pipe-front"]);
    expect(readdirSync(stagedDir(repoRoot, "x64")).sort()).toEqual([
      "vex-mcp.exe",
      "vex-pipe-front.exe",
    ]);
  });

  it("stages ONE binary on a target the front is not built for", async () => {
    const repoRoot = temporaryRoot("vex-stage-linux-");
    writeBinary(path.join(repoRoot, "bridge", "dist", "linux-amd64", "vex-mcp"), elfAmd64("mcp"));

    const stageBridge = await loadStageBridge(repoRoot);
    expect(stageBridge("linux", "x64").map((entry) => entry.name)).toEqual(["vex-mcp"]);
    expect(readdirSync(stagedDir(repoRoot, "x64"))).toEqual(["vex-mcp"]);
  });

  it("clears a previous target's staging directory, so no foreign binary rides along", async () => {
    const repoRoot = temporaryRoot("vex-stage-reuse-");
    const win = path.join(repoRoot, "bridge", "dist", "windows-amd64");
    writeBinary(path.join(win, "vex-mcp.exe"), peAmd64("mcp"));
    writeBinary(path.join(win, "vex-pipe-front.exe"), peAmd64("front"));
    writeBinary(path.join(repoRoot, "bridge", "dist", "linux-amd64", "vex-mcp"), elfAmd64("mcp"));

    const stageBridge = await loadStageBridge(repoRoot);
    stageBridge("win", "x64");
    stageBridge("linux", "x64");

    // The staging directory is keyed by Electron ARCH, not by platform, so
    // `bridge-x64` is genuinely reused across targets. A Windows front left
    // behind here would be packaged into a Linux bundle.
    expect(readdirSync(stagedDir(repoRoot, "x64"))).toEqual(["vex-mcp"]);
  });

  it("fails, and writes NOTHING, when the second artifact was never built", async () => {
    const repoRoot = temporaryRoot("vex-stage-partial-");
    writeBinary(
      path.join(repoRoot, "bridge", "dist", "windows-amd64", "vex-mcp.exe"),
      peAmd64("mcp"),
    );

    const stageBridge = await loadStageBridge(repoRoot);
    expect(() => stageBridge("win", "x64")).toThrow(
      /vex-pipe-front for windows-amd64 is not usable/,
    );
    // A half-populated staging directory is exactly the shape a later step
    // would read as a complete set, so every source is verified before the
    // first byte is written.
    expect(existsSync(stagedDir(repoRoot, "x64"))).toBe(false);
  });
});

// ── afterPack ───────────────────────────────────────────────────────────────

/** electron-builder's own numeric Arch enum, as afterPack receives it. */
const ARCH = { x64: 1, arm64: 3 } as const;

/**
 * A packaged tree in the shape electron-builder produces, with the platform's
 * resources layout: `Contents/Resources` inside a `.app` on darwin, a plain
 * `resources/` everywhere else.
 */
function fakePackage(
  root: string,
  platform: "win32" | "darwin" | "linux",
  arch: number,
  bridgeFiles: Record<string, Buffer>,
): Parameters<typeof verifyPackagedBridge>[0] {
  const appOutDir = path.join(root, "out");
  const resources =
    platform === "darwin"
      ? path.join(appOutDir, "Vex.app", "Contents", "Resources")
      : path.join(appOutDir, "resources");
  mkdirSync(path.join(resources, "bridge"), { recursive: true });
  for (const [name, bytes] of Object.entries(bridgeFiles)) {
    writeBinary(path.join(resources, "bridge", name), bytes);
  }
  return {
    electronPlatformName: platform,
    appOutDir,
    arch,
    packager: { appInfo: { productFilename: "Vex" } },
  };
}

describe("the packaged-bridge assertion", () => {
  it("accepts a Windows package that carries both binaries", async () => {
    const root = temporaryRoot("vex-pack-win-");
    await expect(
      verifyPackagedBridge(
        fakePackage(root, "win32", ARCH.x64, {
          "vex-mcp.exe": peAmd64("mcp"),
          "vex-pipe-front.exe": peAmd64("front"),
        }),
      ),
    ).resolves.toEqual(["vex-mcp", "vex-pipe-front"]);
  });

  it("REJECTS a Windows package missing the front, which used to pass every gate", async () => {
    const root = temporaryRoot("vex-pack-win-partial-");
    await expect(
      verifyPackagedBridge(
        fakePackage(root, "win32", ARCH.x64, { "vex-mcp.exe": peAmd64("mcp") }),
      ),
    ).rejects.toThrow(/packaged Vex Studio vex-pipe-front is wrong or missing/);
  });

  it("does not demand the front on darwin, where it is not built at all", async () => {
    const root = temporaryRoot("vex-pack-mac-");
    await expect(
      verifyPackagedBridge(
        fakePackage(root, "darwin", ARCH.arm64, { "vex-mcp": machoArm64("mcp") }),
      ),
    ).resolves.toEqual(["vex-mcp"]);
  });

  it("still rejects a binary for the wrong machine, per artifact", async () => {
    const root = temporaryRoot("vex-pack-win-wrongarch-");
    await expect(
      verifyPackagedBridge(
        fakePackage(root, "win32", ARCH.x64, {
          "vex-mcp.exe": peAmd64("mcp"),
          // An arm64 front in an x64 bundle: the header, not the file name,
          // is what decides.
          "vex-pipe-front.exe": (() => {
            const bytes = peAmd64("front");
            bytes.writeUInt16LE(0xaa64, 0x44);
            return bytes;
          })(),
        }),
      ),
    ).rejects.toThrow(/executable for arm64; this package needs amd64/);
  });
});
