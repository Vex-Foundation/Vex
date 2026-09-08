/**
 * THE GATES A REPOSITORY-ROOT RUNNER CAN PROVE, over synthetic trees.
 *
 * The Lighter signer helper is the process that holds a trading private key, so
 * the packaging chain around it is a money-path contract. This file owns the
 * parts of it that depend on nothing outside the Node standard library:
 *
 *   1. `vex-app/scripts/stage-lighter-signer.mjs` selects the helpers for the
 *      ONE platform being packaged, verifies their build-time digests, and on
 *      Windows records their pre-sign Authenticode content digests;
 *   2. `vex-app/scripts/lighter-signer-artifact.mjs` is what
 *      `check-build-artifacts.mjs` asks whether the build output is complete;
 *   3. the release workflow's step order, and the pinned Go toolchain check.
 *
 * THE PACKAGE-TIME GATES LIVE ELSEWHERE, in
 * `vex-app/src/main/lighter/__tests__/signer-packaging.test.ts`:
 * `build/afterPack.mjs` and `scripts/check-packaged-payload.mjs` import
 * `vex-app/node_modules` packages (`@electron/fuses`, `@electron/asar`,
 * `app-builder-lib`) that the repository-root CI job does not install, so
 * driving them from here fails with ERR_MODULE_NOT_FOUND in CI while passing on
 * a developer machine. That split is the same one the bridge's suites use.
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
 * `import.meta.url`-relative resolution honest.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const APP_SCRIPTS = path.join(REPO_ROOT, "vex-app", "scripts");

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

/**
 * A STRUCTURALLY REAL PE32+ over a few bytes of payload: DOS stub, PE
 * signature, COFF header, a full 240-byte optional header with its sixteen data
 * directories, and one section.
 *
 * Real headers rather than the four fields the machine check reads, because
 * `authenticodeContentSha256` walks the same structure signtool does -
 * SizeOfHeaders, the CheckSum field, the certificate table directory entry, the
 * section table - and a stub PE would let the gate under test parse nothing.
 * The layout follows the real helpers, which this suite cannot use: they are
 * build output, git-ignored, and only exist on a machine with the pinned Go
 * toolchain.
 */
function pe(payload: string, machine: number): Buffer {
  const SIZE_OF_HEADERS = 0x200;
  const body = Buffer.from(payload, "utf8");
  const rawSize = Math.ceil(Math.max(body.length, 1) / 0x200) * 0x200;
  const file = Buffer.alloc(SIZE_OF_HEADERS + rawSize, 0);

  file.write("MZ", 0, "ascii");
  file.writeUInt32LE(0x40, 0x3c);
  file.write("PE\0\0", 0x40, "ascii");
  const coff = 0x44;
  file.writeUInt16LE(machine, coff);
  file.writeUInt16LE(1, coff + 2); // NumberOfSections
  file.writeUInt16LE(240, coff + 16); // SizeOfOptionalHeader
  file.writeUInt16LE(0x22, coff + 18); // Characteristics: EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

  const optional = coff + 20;
  file.writeUInt16LE(0x20b, optional); // PE32+
  file.writeUInt32LE(SIZE_OF_HEADERS + rawSize, optional + 56); // SizeOfImage
  file.writeUInt32LE(SIZE_OF_HEADERS, optional + 60);
  file.writeUInt32LE(0, optional + 64); // CheckSum, which signing rewrites
  file.writeUInt32LE(16, optional + 108); // NumberOfRvaAndSizes

  const sectionTable = optional + 240;
  file.write(".text\0\0\0", sectionTable, "ascii");
  file.writeUInt32LE(rawSize, sectionTable + 16); // SizeOfRawData
  file.writeUInt32LE(SIZE_OF_HEADERS, sectionTable + 20); // PointerToRawData
  body.copy(file, SIZE_OF_HEADERS);
  return file;
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
    // No content manifest: nothing rewrites a Mach-O on its way into the
    // package, so its build digest still answers the provenance question.
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
    //
    // The pre-sign content manifest sits beside them, and only on Windows;
    // `extraResources` copies `vex-lighter-signer-*` only, so it stays in the
    // workspace rather than shipping.
    expect(readdirSync(stagedDir(root)).filter((name) => name !== ".gitignore").sort()).toEqual([
      "AUTHENTICODE-SHA256SUMS",
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

/**
 * THE RELEASE ORDER ITSELF, read out of the workflow rather than restated.
 *
 * The gates are only correct in one order: stage (provenance and the pre-sign
 * content record on unsigned bytes), package (afterPack, where Windows bytes
 * are already signed), then `check:package` (the shipped bytes). If a future
 * edit moved `check:package` before packaging, or dropped the staging step,
 * every assertion in this file and in
 * `vex-app/src/main/lighter/__tests__/signer-packaging.test.ts` would still
 * pass while the release proved nothing. This test lives at the root because it
 * reads a YAML file and needs nothing installed.
 */
describe("the release workflow's Lighter signer step order", () => {
  const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
  const yaml = readFileSync(WORKFLOW, "utf8");

  /** One top-level job's block, from its key to the next key at that indent. */
  function jobBlock(job: string): string {
    const start = yaml.indexOf(`\n  ${job}:\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = yaml.slice(start + 1);
    const next = /\n {2}[a-z0-9_-]+:\n/.exec(rest.slice(1));
    return next === null ? rest : rest.slice(0, next.index + 1);
  }

  /** Where a command appears inside a job block, or -1. */
  function commandIndex(block: string, command: string): number {
    return block.indexOf(command);
  }

  const SIGNING_JOBS = [
    ["macos", "node scripts/stage-lighter-signer.mjs --platform mac", "pnpm exec electron-builder --mac"],
    ["windows", "node scripts/stage-lighter-signer.mjs --platform win", "pnpm exec electron-builder --win"],
  ] as const;

  for (const [job, stage, packageCommand] of SIGNING_JOBS) {
    it(`stages, then packages, then verifies signatures on ${job}`, () => {
      const block = jobBlock(job);
      const staged = commandIndex(block, stage);
      const packaged = commandIndex(block, packageCommand);
      const checked = commandIndex(block, "pnpm run check:package");

      expect(staged).toBeGreaterThan(-1);
      expect(packaged).toBeGreaterThan(staged);
      // Post-signing evidence has to come after the invocation that signs.
      expect(checked).toBeGreaterThan(packaged);
      // The block really is ONE job: an extractor that returned the whole file
      // would satisfy every ordering assertion above by accident.
      for (const [other, , otherPackageCommand] of SIGNING_JOBS) {
        if (other !== job) expect(commandIndex(block, otherPackageCommand)).toBe(-1);
      }
    });
  }

  it("stages the Linux helpers before packaging, and expects no signature step", () => {
    const block = jobBlock("linux");
    const staged = commandIndex(block, "node scripts/stage-lighter-signer.mjs --platform linux");
    const packaged = commandIndex(block, "pnpm exec electron-builder --linux");

    expect(staged).toBeGreaterThan(-1);
    expect(packaged).toBeGreaterThan(staged);
    // Linux packages carry no platform signature, so the digest proven at
    // staging and re-proven in afterPack is the whole of the evidence.
    expect(commandIndex(block, "pnpm run check:package")).toBe(-1);
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
