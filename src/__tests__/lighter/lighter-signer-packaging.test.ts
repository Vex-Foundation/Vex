/**
 * THE THREE GATES BETWEEN A BUILT SIGNER HELPER AND A SIGNED PACKAGE, over
 * synthetic trees.
 *
 * The Lighter signer helper is the process that holds a trading private key, so
 * the packaging chain around it is a money-path contract:
 *
 *   1. `vex-app/scripts/stage-lighter-signer.mjs` selects the helpers for the
 *      ONE platform being packaged and verifies their build-time digests;
 *   2. `vex-app/build/afterPack.mjs` re-inspects what electron-builder actually
 *      packaged, BEFORE codesigning, and refuses a foreign or altered helper;
 *   3. `vex-app/scripts/lighter-signer-artifact.mjs` is what
 *      `check-build-artifacts.mjs` asks whether the build output is complete.
 *
 * The binaries here are FAKE - real Mach-O, PE and ELF headers over a few bytes
 * of payload - exactly as in the bridge's own packaging suite
 * (`vex-app/src/main/studio/__tests__/bridge-staging-and-packaging.test.ts`,
 * whose structure this mirrors). Every gate reads each file's OWN header, so a
 * header is what they can be proven against, and a synthetic tree is the only
 * way to exercise the macOS and Windows shapes from a Linux runner. What a fake
 * cannot prove - that the Go build emits these names - is proven by
 * `check-build-artifacts.mjs` on a machine with the pinned toolchain.
 *
 * The modules are ESM scripts under `vex-app/`, so they are driven through a
 * real `node` child process rather than imported here: that is how they run in
 * production (electron-builder hooks and package scripts), and it keeps their
 * `import.meta.url`-relative resolution and their `vex-app/node_modules`
 * dependencies honest.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const APP_SCRIPTS = path.join(REPO_ROOT, "vex-app", "scripts");
const AFTER_PACK = path.join(REPO_ROOT, "vex-app", "build", "afterPack.mjs");

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function machoArm64(payload: string): Buffer {
  const head = Buffer.alloc(64, 0);
  head[0] = 0xcf;
  head[1] = 0xfa;
  head[2] = 0xed;
  head[3] = 0xfe;
  head.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

function machoAmd64(payload: string): Buffer {
  const head = Buffer.alloc(64, 0);
  head[0] = 0xcf;
  head[1] = 0xfa;
  head[2] = 0xed;
  head[3] = 0xfe;
  head.writeUInt32LE(0x01000007, 4); // CPU_TYPE_X86_64
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

function elf(payload: string, machine: number): Buffer {
  const head = Buffer.alloc(64, 0);
  head[0] = 0x7f;
  head.write("ELF", 1, "ascii");
  head[4] = 2;
  head[5] = 1;
  head.writeUInt16LE(machine, 18);
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

function pe(payload: string, machine: number): Buffer {
  const head = Buffer.alloc(128, 0);
  head.write("MZ", 0, "ascii");
  head.writeUInt32LE(0x40, 0x3c);
  head.write("PE\0\0", 0x40, "ascii");
  head.writeUInt16LE(machine, 0x44);
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

/** Every helper the table knows, as fake but structurally real executables. */
const FAKE_HELPERS: ReadonlyArray<readonly [string, Buffer]> = [
  ["vex-lighter-signer-darwin-arm64", machoArm64("darwin-arm64")],
  ["vex-lighter-signer-darwin-x64", machoAmd64("darwin-x64")],
  ["vex-lighter-signer-linux-arm64", elf("linux-arm64", 0xb7)],
  ["vex-lighter-signer-linux-x64", elf("linux-x64", 0x3e)],
  ["vex-lighter-signer-win32-arm64.exe", pe("win32-arm64", 0xaa64)],
  ["vex-lighter-signer-win32-x64.exe", pe("win32-x64", 0x8664)],
];

function writeBinary(file: string, bytes: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  chmodSync(file, 0o755);
}

/** A build output directory with all six helpers and a matching SHA256SUMS. */
function fakeBuiltDir(root: string, overrides: Record<string, Buffer> = {}): string {
  const dir = path.join(root, "vex-app", "resources", "lighter-signer");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const [name, bytes] of FAKE_HELPERS) {
    const written = overrides[name] ?? bytes;
    writeBinary(path.join(dir, name), written);
    // The manifest records the ORIGINAL bytes, so an override models a helper
    // that changed after the build recorded it.
    lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  writeFileSync(path.join(dir, "SHA256SUMS"), `${lines.sort().join("\n")}\n`);
  return dir;
}

/** Run one expression against the real modules in a real node process. */
function runDriver(root: string, body: string): { ok: boolean; value?: unknown; message?: string } {
  const driver = path.join(root, "driver.mjs");
  writeFileSync(driver, body);
  const stdout = execFileSync(process.execPath, [driver], { encoding: "utf8" });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    ok: boolean;
    value?: unknown;
    message?: string;
  };
}

/**
 * The REAL staging script, loaded so its own `import.meta.url` sits inside a
 * synthetic tree.
 *
 * It resolves the app root from its own location, on purpose: that is what
 * makes it correct from any working directory. Rather than adding a test-only
 * root parameter to a production module, the module and the artifact table it
 * imports are copied into `<root>/vex-app/scripts/`, so the code under test is
 * byte-for-byte the shipped code.
 */
function stage(root: string, platform: string): { ok: boolean; value?: unknown; message?: string } {
  const scriptsDir = path.join(root, "vex-app", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const name of ["stage-lighter-signer.mjs", "lighter-signer-artifact.mjs", "bridge-artifact.mjs"]) {
    writeFileSync(path.join(scriptsDir, name), readFileSync(path.join(APP_SCRIPTS, name), "utf8"));
  }
  return runDriver(root, `
    import { stageLighterSigner } from ${JSON.stringify(path.join(scriptsDir, "stage-lighter-signer.mjs"))};
    try {
      const staged = stageLighterSigner(${JSON.stringify(platform)});
      console.log(JSON.stringify({ ok: true, value: staged.map((entry) => entry.name) }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }));
    }
  `);
}

function stagedDir(root: string): string {
  return path.join(root, "vex-app", "resources", "lighter-signer-staged");
}

describe("staging the Lighter signer helpers for one platform", () => {
  it("stages both macOS helpers, and only those", () => {
    const root = temporaryRoot("vex-lighter-stage-mac-");
    fakeBuiltDir(root);

    expect(stage(root, "mac")).toMatchObject({
      ok: true,
      value: ["vex-lighter-signer-darwin-arm64", "vex-lighter-signer-darwin-x64"],
    });
    expect(readdirSync(stagedDir(root)).filter((name) => name !== ".gitignore").sort()).toEqual([
      "vex-lighter-signer-darwin-arm64",
      "vex-lighter-signer-darwin-x64",
    ]);
  });

  it("clears the previous platform's helpers, so none rides along into the next package", () => {
    const root = temporaryRoot("vex-lighter-stage-reuse-");
    fakeBuiltDir(root);

    stage(root, "mac");
    expect(stage(root, "win")).toMatchObject({ ok: true });

    // A Windows package that still carried the two Mach-O helpers would ship
    // two executables it can never run, and on macOS the mirror image of that
    // mistake is two unsigned binaries inside a notarized bundle.
    expect(readdirSync(stagedDir(root)).filter((name) => name !== ".gitignore").sort()).toEqual([
      "vex-lighter-signer-win32-arm64.exe",
      "vex-lighter-signer-win32-x64.exe",
    ]);
  });

  it("refuses a helper whose bytes no longer match SHA256SUMS, and stages nothing", () => {
    const root = temporaryRoot("vex-lighter-stage-tampered-");
    fakeBuiltDir(root, {
      "vex-lighter-signer-darwin-x64": machoAmd64("darwin-x64-tampered-after-the-build"),
    });

    const result = stage(root, "mac");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/SHA256SUMS records/);
    // Every source is verified before the first byte is written: a
    // half-populated staging directory is exactly what a later step would read
    // as a complete set.
    expect(existsSync(stagedDir(root))).toBe(false);
  });

  it("refuses a platform the helper is not built for, by name", () => {
    const root = temporaryRoot("vex-lighter-stage-unknown-");
    fakeBuiltDir(root);

    const result = stage(root, "freebsd");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unknown packaging platform "freebsd"/);
  });
});

/** electron-builder's own numeric Arch enum, as afterPack receives it. */
const ARCH = { x64: 1, arm64: 3 } as const;

/** A packaged tree in the shape electron-builder produces. */
function fakePackage(
  root: string,
  platform: "darwin" | "win32" | "linux",
  helpers: ReadonlyArray<readonly [string, Buffer]>,
): { appOutDir: string; context: Record<string, unknown> } {
  const appOutDir = path.join(root, "dist-electron", `${platform}-unpacked`);
  const resources = platform === "darwin"
    ? path.join(appOutDir, "Vex.app", "Contents", "Resources")
    : path.join(appOutDir, "resources");
  for (const [name, bytes] of helpers) {
    writeBinary(path.join(resources, "lighter-signer", name), bytes);
  }
  return {
    appOutDir,
    context: {
      electronPlatformName: platform,
      appOutDir,
      arch: ARCH.arm64,
      packager: { appInfo: { productFilename: "Vex" } },
    },
  };
}

function verifyPackaged(
  root: string,
  context: Record<string, unknown>,
  builtDir: string,
): { ok: boolean; value?: unknown; message?: string } {
  return runDriver(root, `
    import { verifyPackagedLighterSigner } from ${JSON.stringify(AFTER_PACK)};
    try {
      const accepted = verifyPackagedLighterSigner(
        ${JSON.stringify(context)},
        { builtDir: ${JSON.stringify(builtDir)} },
      );
      console.log(JSON.stringify({ ok: true, value: accepted }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }));
    }
  `);
}

describe("verifying the packaged Lighter signer before it is signed", () => {
  const darwinHelpers = FAKE_HELPERS.filter(([name]) => name.includes("darwin"));

  it("accepts exactly this platform's helpers with the digests the build recorded", () => {
    const root = temporaryRoot("vex-lighter-pack-ok-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "darwin", darwinHelpers);

    expect(verifyPackaged(root, context, builtDir)).toMatchObject({
      ok: true,
      value: ["vex-lighter-signer-darwin-arm64", "vex-lighter-signer-darwin-x64"],
    });
  });

  it("refuses a package that also carries another platform's helper", () => {
    const root = temporaryRoot("vex-lighter-pack-foreign-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "darwin", [
      ...darwinHelpers,
      ...FAKE_HELPERS.filter(([name]) => name.includes("win32")),
    ]);

    const result = verifyPackaged(root, context, builtDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/signer helpers for other platforms/);
    expect(result.message).toMatch(/vex-lighter-signer-win32-x64\.exe/);
  });

  it("refuses a helper that was replaced after the build recorded its digest", () => {
    const root = temporaryRoot("vex-lighter-pack-swapped-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "darwin", [
      ["vex-lighter-signer-darwin-arm64", machoArm64("a-different-signer-entirely")],
      darwinHelpers[1],
    ]);

    const result = verifyPackaged(root, context, builtDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/has sha256 .* but SHA256SUMS records/);
  });

  it("refuses a helper built for the wrong machine", () => {
    const root = temporaryRoot("vex-lighter-pack-arch-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "darwin", [
      // The x64 Mach-O under the arm64 name: the same mistake a stale copy or a
      // crossed staging directory produces.
      ["vex-lighter-signer-darwin-arm64", machoAmd64("darwin-x64")],
      darwinHelpers[1],
    ]);

    const result = verifyPackaged(root, context, builtDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/executable for amd64; this target needs arm64/);
  });

  it("refuses a package with no signer directory at all", () => {
    const root = temporaryRoot("vex-lighter-pack-missing-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "linux", []);

    const result = verifyPackaged(root, context, builtDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/packaged Lighter signer directory is missing/);
  });
});

describe("the build-output check over the signer helpers", () => {
  function evaluate(root: string, builtDir: string): { issues: string[]; verified: unknown[] } {
    const result = runDriver(root, `
      import { evaluateBuiltLighterSigners } from ${JSON.stringify(path.join(APP_SCRIPTS, "lighter-signer-artifact.mjs"))};
      console.log(JSON.stringify({ ok: true, value: evaluateBuiltLighterSigners(${JSON.stringify(builtDir)}) }));
    `);
    return result.value as { issues: string[]; verified: unknown[] };
  }

  it("accepts a complete build and reports every digest it accepted", () => {
    const root = temporaryRoot("vex-lighter-build-ok-");
    const evaluated = evaluate(root, fakeBuiltDir(root));
    expect(evaluated.issues).toEqual([]);
    expect(evaluated.verified).toHaveLength(FAKE_HELPERS.length);
  });

  it("names a missing helper and a helper whose bytes changed", () => {
    const root = temporaryRoot("vex-lighter-build-bad-");
    const builtDir = fakeBuiltDir(root, {
      "vex-lighter-signer-linux-x64": elf("rebuilt-elsewhere", 0x3e),
    });
    rmSync(path.join(builtDir, "vex-lighter-signer-win32-arm64.exe"));

    const evaluated = evaluate(root, builtDir);
    expect(evaluated.issues).toEqual([
      "vex-lighter-signer-linux-x64: " +
        `${path.join(builtDir, "vex-lighter-signer-linux-x64")} has sha256 ` +
        `${createHash("sha256").update(elf("rebuilt-elsewhere", 0x3e)).digest("hex")}, ` +
        "but SHA256SUMS records " +
        `${createHash("sha256").update(elf("linux-x64", 0x3e)).digest("hex")} ` +
        "for vex-lighter-signer-linux-x64",
      "vex-lighter-signer-win32-arm64.exe: missing",
    ]);
  });

  it("refuses a build output with no digest manifest", () => {
    const root = temporaryRoot("vex-lighter-build-nomanifest-");
    const builtDir = fakeBuiltDir(root);
    rmSync(path.join(builtDir, "SHA256SUMS"));

    const evaluated = evaluate(root, builtDir);
    expect(evaluated.issues).toHaveLength(1);
    expect(evaluated.issues[0]).toMatch(/missing .*SHA256SUMS/);
  });
});

describe("the post-signing gate over the packaged Lighter signer", () => {
  const CHECK_PAYLOAD = path.join(REPO_ROOT, "vex-app", "scripts", "check-packaged-payload.mjs");

  function verifySignature(
    root: string,
    platform: string,
    resources: string,
  ): { issues: string[]; notes: string[] } {
    const result = runDriver(root, `
      import { verifyPackagedLighterSignerSignature } from ${JSON.stringify(CHECK_PAYLOAD)};
      const payload = {
        target: { platform: ${JSON.stringify(platform)}, arch: "x64" },
        resources: ${JSON.stringify(resources)},
      };
      console.log(JSON.stringify({ ok: true, value: verifyPackagedLighterSignerSignature(payload) }));
    `);
    return result.value as { issues: string[]; notes: string[] };
  }

  it("fails when a packaged helper is absent, before it ever asks about signatures", () => {
    const root = temporaryRoot("vex-lighter-sig-missing-");
    const { appOutDir } = fakePackage(root, "linux", [FAKE_HELPERS[2]]);

    const { issues } = verifySignature(root, "linux", path.join(appOutDir, "resources"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/vex-lighter-signer-linux-x64/);
    expect(issues[0]).toMatch(/MISSING from the payload/);
  });

  it("states plainly that a Linux package carries no platform signature", () => {
    const root = temporaryRoot("vex-lighter-sig-linux-");
    const { appOutDir } = fakePackage(
      root,
      "linux",
      FAKE_HELPERS.filter(([name]) => name.includes("linux")),
    );

    const { issues, notes } = verifySignature(root, "linux", path.join(appOutDir, "resources"));
    expect(issues).toEqual([]);
    // Reported, never silently skipped: a gate that says nothing when it cannot
    // look is indistinguishable from one that passed.
    expect(notes).toEqual([
      "Linux packages carry no platform code signature; the helper is verified by digest only",
    ]);
  });

  it("says which host the macOS evidence has to come from, rather than passing", () => {
    const root = temporaryRoot("vex-lighter-sig-darwin-");
    const { appOutDir } = fakePackage(
      root,
      "darwin",
      FAKE_HELPERS.filter(([name]) => name.includes("darwin")),
    );

    const { issues, notes } = verifySignature(
      root,
      "darwin",
      path.join(appOutDir, "Vex.app", "Contents", "Resources"),
    );
    expect(issues).toEqual([]);
    expect(notes.join(" ")).toMatch(
      process.platform === "darwin"
        ? /carries no valid signature/
        : /cannot be verified from a \w+ host/,
    );
  });
});

describe("the pinned Go toolchain for the signer helper", () => {
  const VERIFY = path.join(REPO_ROOT, "scripts", "verify-runtime-toolchain.mjs");
  const PINNED_GO = /^toolchain go(\S+)$/m.exec(
    readFileSync(path.join(REPO_ROOT, "src", "tools", "lighter", "signer-runtime", "go.mod"), "utf8"),
  )?.[1];
  const PINNED_PNPM = /^pnpm@(\S+)$/.exec(
    (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      packageManager: string;
    }).packageManager,
  )?.[1];

  /** A `go` on PATH that answers with the version this test chooses. */
  function fakeGo(version: string): string {
    const root = temporaryRoot("vex-lighter-go-");
    const file = path.join(root, "go");
    writeFileSync(file, `#!/bin/sh\necho "go version go${version} linux/amd64"\n`);
    chmodSync(file, 0o755);
    return root;
  }

  function runToolchainCheck(goVersion: string): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [VERIFY], {
        encoding: "utf8",
        env: {
          PATH: fakeGo(goVersion),
          npm_config_user_agent: `pnpm/${PINNED_PNPM ?? ""} npm/? node/${process.version}`,
        },
      });
      return { status: 0, output: stdout };
    } catch (error) {
      const failure = error as { status: number; stdout: string; stderr: string };
      return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
    }
  }

  const posixOnly = process.platform === "win32" ? it.skip : it;

  posixOnly("accepts exactly the pinned compiler", () => {
    expect(PINNED_GO).toBeDefined();
    const result = runToolchainCheck(PINNED_GO ?? "");
    expect(result.status).toBe(0);
    expect(result.output).toContain(`Go ${PINNED_GO}`);
  });

  posixOnly("refuses a different local Go, naming both versions", () => {
    const result = runToolchainCheck("1.20.0");
    expect(result.status).toBe(1);
    expect(result.output).toContain("Go 1.20.0 does not match");
    expect(result.output).toContain(`Go ${PINNED_GO}`);
    // The helper is a signing binary; an unreviewed compiler is not an
    // acceptable input to it, however convenient the local install is.
    expect(result.output).toMatch(/built by the pinned compiler or not at all/);
  });
});
