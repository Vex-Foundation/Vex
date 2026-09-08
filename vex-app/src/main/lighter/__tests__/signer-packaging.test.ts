/**
 * THE PACKAGE-TIME GATES OVER THE LIGHTER SIGNER HELPER, over synthetic trees.
 *
 * The helper is the process that holds a trading private key, so the packaging
 * chain around it is a money-path contract. This file owns the two gates that
 * can only run inside `vex-app`:
 *
 *   1. `vex-app/build/afterPack.mjs` re-inspects what electron-builder actually
 *      packaged and refuses a foreign, altered or stale helper;
 *   2. `vex-app/scripts/check-packaged-payload.mjs` re-asserts the same facts
 *      over the shipped payload, after signing.
 *
 * WHY IT LIVES HERE and not beside the artifact tests in
 * `src/__tests__/lighter/lighter-signer-packaging.test.ts`: both modules import
 * `vex-app/node_modules` packages (`@electron/fuses`, `@electron/asar`,
 * `app-builder-lib`), which the repository-root CI job does not install. Driven
 * from the root project they fail with ERR_MODULE_NOT_FOUND in CI while passing
 * on a developer machine, which is the worst of both. The bridge's equivalent
 * suite (`src/main/studio/__tests__/bridge-staging-and-packaging.test.ts`)
 * belongs to this project for the same reason. The root file keeps what needs
 * nothing from `vex-app/node_modules`: manifest parsing, header inspection, the
 * staging script's provenance refusal, and the release workflow's step order.
 *
 * The binaries here are FAKE - real Mach-O, PE and ELF headers over a few bytes
 * of payload - exactly as in the bridge's suite, whose structure this mirrors.
 * Every gate reads each file's OWN header, so a header is what they can be
 * proven against, and a synthetic tree is the only way to exercise the macOS
 * and Windows shapes from a Linux runner. What a fake cannot prove - that the
 * Go build emits these names - is proven by `check-build-artifacts.mjs` on a
 * machine with the pinned toolchain.
 *
 * The modules are ESM scripts under `vex-app/`, so they are driven through a
 * real `node` child process rather than imported here: that is how they run in
 * production (electron-builder hooks and package scripts), it keeps their
 * `import.meta.url`-relative resolution honest, and it is what lets a test hand
 * the signature-tool seam a fake without a Windows host or a signing identity.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const APP_SCRIPTS = path.join(APP_ROOT, "scripts");
const AFTER_PACK = path.join(APP_ROOT, "build", "afterPack.mjs");
const CHECK_PAYLOAD = path.join(APP_SCRIPTS, "check-packaged-payload.mjs");

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

/**
 * The three edits Authenticode signing is allowed to make, and nothing else:
 * the CheckSum field, the certificate table data directory entry, and an
 * appended attribute certificate table.
 *
 * This is the transformation electron-builder's signer applies while COPYING
 * the helper into resources (winPackager `createTransformerForExtraFiles`), and
 * modelling it exactly is what lets a Linux runner prove the gate's Windows
 * branch without a certificate. `certificate` stands in for the signature blob;
 * different bytes there model a re-signing or a second (nested) signature, and
 * the content digest must be indifferent to both.
 */
function authenticodeSigned(unsigned: Buffer, certificate = "a-signature-blob"): Buffer {
  const file = Buffer.from(unsigned);
  const optional = 0x44 + 20;
  const dataDirectories = optional + 112;
  const blob = Buffer.alloc(Math.ceil((8 + certificate.length) / 8) * 8, 0);
  blob.writeUInt32LE(blob.length, 0); // dwLength
  blob.writeUInt16LE(0x0200, 4); // wRevision: WIN_CERT_REVISION_2_0
  blob.writeUInt16LE(0x0002, 6); // wCertificateType: PKCS_SIGNED_DATA
  blob.write(certificate, 8, "ascii");

  file.writeUInt32LE(0xdeadbeef, optional + 64); // the CheckSum signing recomputes
  file.writeUInt32LE(file.length, dataDirectories + 4 * 8);
  file.writeUInt32LE(blob.length, dataDirectories + 4 * 8 + 4);
  return Buffer.concat([file, blob]);
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

/** One helper from the table BY NAME: a case that names the file it stands beside cannot silently pick the wrong one. */
function fakeHelper(name: string): readonly [string, Buffer] {
  const entry = FAKE_HELPERS.find(([candidate]) => candidate === name);
  if (entry === undefined) throw new Error(`no fake helper named ${name}`);
  return entry;
}

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

/**
 * The platform signature tool, faked at the seam `verifyPackagedLighterSigner`
 * exposes for exactly this reason: a Linux runner has neither `codesign` nor
 * `Get-AuthenticodeSignature`, and no test may hold a signing identity.
 *
 * The DEFAULT throws. Every call site that does not pass its own fake is
 * therefore asserting that the gate never consulted a signature tool at all,
 * which is the contract on macOS, on Linux, and on an unsigned Windows build.
 */
const SIGNATURE_TOOL_MUST_NOT_BE_CONSULTED =
  '(file) => { throw new Error("the signature tool was consulted for " + file); }';

/** A fake that answers `Valid` for every file, as a signed Windows build would. */
const SIGNATURE_VALID = '() => ({ verified: true, detail: "Valid" })';

/** A fake that answers `NotSigned`, as an unsigned helper in a signed build would. */
const SIGNATURE_NOT_SIGNED = '() => ({ verified: false, detail: "NotSigned" })';

function verifyPackaged(
  root: string,
  context: Record<string, unknown>,
  builtDir: string,
  inspectSignature: string = SIGNATURE_TOOL_MUST_NOT_BE_CONSULTED,
): { ok: boolean; value?: unknown; message?: string } {
  return runDriver(root, `
    import { verifyPackagedLighterSigner } from ${JSON.stringify(AFTER_PACK)};
    try {
      const accepted = verifyPackagedLighterSigner(
        ${JSON.stringify(context)},
        { builtDir: ${JSON.stringify(builtDir)}, inspectSignature: ${inspectSignature} },
      );
      console.log(JSON.stringify({ ok: true, value: accepted }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }));
    }
  `);
}

/**
 * The Windows helpers as electron-builder leaves them after signing them during
 * the copy: this build's own bytes, plus a certificate table.
 */
function signedWindowsHelpers(certificate?: string): ReadonlyArray<readonly [string, Buffer]> {
  return FAKE_HELPERS.filter(([name]) => name.includes("win32")).map(
    ([name, bytes]) => [name, authenticodeSigned(bytes, certificate)] as const,
  );
}

describe("verifying the packaged Lighter signer in the afterPack hook", () => {
  const darwinHelpers = FAKE_HELPERS.filter(([name]) => name.includes("darwin"));
  const windowsHelpers = FAKE_HELPERS.filter(([name]) => name.includes("win32"));

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
      fakeHelper("vex-lighter-signer-darwin-x64"),
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
      fakeHelper("vex-lighter-signer-darwin-x64"),
    ]);

    const result = verifyPackaged(root, context, builtDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/executable for amd64; this target needs arm64/);
  });

  /**
   * WHAT THE PACKAGED BYTES ARE WHEN THIS HOOK RUNS, per platform, read out of
   * the installed app-builder-lib 26 rather than assumed: `copyFiles` over the
   * extraResource matchers runs BEFORE `emitAfterPack` (platformPackager.js
   * `doPack`), and on Windows that copy goes through
   * `createTransformerForExtraFiles`, which Authenticode-signs every `.exe` it
   * accepts (winPackager.js). So macOS and Linux see the unsigned build output
   * and Windows may not.
   *
   * When nothing rewrote the file, EVERY platform proves provenance by digest
   * and none of them consults a signature tool - which the default fake
   * asserts by throwing if it is called.
   */
  const UNCHANGED_BYTES_PER_PLATFORM = [
    ["darwin", darwinHelpers],
    ["linux", FAKE_HELPERS.filter(([name]) => name.includes("linux"))],
    ["win32", windowsHelpers],
  ] as const;

  for (const [platform, helpers] of UNCHANGED_BYTES_PER_PLATFORM) {
    it(`accepts unchanged ${platform} bytes by digest alone, asking no signature tool`, () => {
      const root = temporaryRoot(`vex-lighter-pack-plain-${platform}-`);
      const builtDir = fakeBuiltDir(root);
      const { context } = fakePackage(root, platform, helpers);

      expect(verifyPackaged(root, context, builtDir)).toMatchObject({
        ok: true,
        value: helpers.map(([name]) => name),
      });
    });
  }

  /**
   * THE REGRESSION THIS GATE WAS BLIND TO. On Windows the helper is signed
   * while it is copied into `resources`, so by the time afterPack looks the
   * bytes no longer match SHA256SUMS. The old gate compared digests on every
   * platform, which passed every unsigned local package and would have failed
   * every signed release - the shape of defect that only ever appears in
   * production.
   */
  it("accepts THIS build's helper after the signing transformation, under a valid signature", () => {
    const root = temporaryRoot("vex-lighter-pack-win-signed-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "win32", signedWindowsHelpers());

    expect(verifyPackaged(root, context, builtDir, SIGNATURE_VALID)).toMatchObject({
      ok: true,
      value: ["vex-lighter-signer-win32-arm64.exe", "vex-lighter-signer-win32-x64.exe"],
    });
  });

  it("accepts a re-signed or dual-signed helper: the content digest ignores the blob", () => {
    const root = temporaryRoot("vex-lighter-pack-win-nested-");
    const builtDir = fakeBuiltDir(root);
    // electron-builder signs sha1 then sha256 by default (windowsSignToolManager
    // `signFile` loops over `signingHashAlgorithms` with `isNest`), and a
    // timestamp grows the blob again. None of that may move the binding.
    const { context } = fakePackage(root, "win32", signedWindowsHelpers("a-nested-sha256-signature-and-a-timestamp"));

    expect(verifyPackaged(root, context, builtDir, SIGNATURE_VALID)).toMatchObject({ ok: true });
  });

  /**
   * THE HOLE THIS SUITE EXISTS TO CLOSE (Codex review, round 1, finding A1).
   * Accepting a changed Windows helper on the strength of its signature alone
   * accepts every binary our own certificate ever signed - starting with the
   * previous release's helper, which is exactly what a stale or crossed staging
   * directory would leave behind.
   */
  it("refuses an older release's helper, signed by the same publisher", () => {
    const root = temporaryRoot("vex-lighter-pack-win-stale-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "win32", [
      [
        "vex-lighter-signer-win32-arm64.exe",
        authenticodeSigned(pe("win32-arm64-as-it-was-two-releases-ago", 0xaa64)),
      ],
      ...signedWindowsHelpers().filter(([name]) => name.includes("x64")),
    ]);

    const result = verifyPackaged(root, context, builtDir, SIGNATURE_VALID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/is NOT this build's vex-lighter-signer-win32-arm64\.exe/);
    expect(result.message).toMatch(/our own certificate signs whatever it is given/);
  });

  it("refuses an unrelated signed executable of the right architecture", () => {
    const root = temporaryRoot("vex-lighter-pack-win-unrelated-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "win32", [
      // A real, valid, correctly-machined, validly signed PE that is simply not
      // our signer: a renamed installer helper, a tool copied in by a build
      // step. The header check cannot see it and the signature vouches for it.
      ["vex-lighter-signer-win32-arm64.exe", authenticodeSigned(pe("some-other-tool-entirely", 0xaa64))],
      ...signedWindowsHelpers().filter(([name]) => name.includes("x64")),
    ]);

    const result = verifyPackaged(root, context, builtDir, SIGNATURE_VALID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Its Authenticode content digest is [0-9a-f]{64}/);
  });

  it("refuses Windows bytes that differ from the build AND carry no valid signature", () => {
    const root = temporaryRoot("vex-lighter-pack-win-unsigned-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "win32", [
      ["vex-lighter-signer-win32-arm64.exe", pe("a-different-signer-entirely", 0xaa64)],
      fakeHelper("vex-lighter-signer-win32-x64.exe"),
    ]);

    const result = verifyPackaged(root, context, builtDir, SIGNATURE_NOT_SIGNED);
    expect(result.ok).toBe(false);
    // Provenance is settled before signatures are discussed, so this is the
    // message even though the file is also unsigned.
    expect(result.message).toMatch(/is NOT this build's vex-lighter-signer-win32-arm64\.exe/);
  });

  it("refuses this build's helper when the signature over it does not verify", () => {
    const root = temporaryRoot("vex-lighter-pack-win-badsig-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "win32", signedWindowsHelpers());

    // Content binding satisfied, signature not: someone appended a certificate
    // table the platform rejects. Both facts are required, never either one.
    const result = verifyPackaged(root, context, builtDir, SIGNATURE_NOT_SIGNED);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/NO valid Authenticode signature/);
    expect(result.message).toMatch(/NotSigned/);
  });

  it("fails closed when the signature tool cannot be run over a bound helper", () => {
    const root = temporaryRoot("vex-lighter-pack-win-notool-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "win32", signedWindowsHelpers());

    const result = verifyPackaged(
      root,
      context,
      builtDir,
      '() => { throw new Error("powershell is not on PATH"); }',
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/signature could not be checked: powershell is not on PATH/);
  });

  it("refuses a Windows helper for the wrong machine, however valid its signature", () => {
    const root = temporaryRoot("vex-lighter-pack-win-arch-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "win32", [
      // The x64 PE under the arm64 name. A signature says who vouched for the
      // bytes, never which machine they run on, so the header check has to
      // stand in front of the signature escape hatch.
      ["vex-lighter-signer-win32-arm64.exe", pe("win32-x64", 0x8664)],
      fakeHelper("vex-lighter-signer-win32-x64.exe"),
    ]);

    const result = verifyPackaged(root, context, builtDir, SIGNATURE_VALID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/executable for amd64; this target needs arm64/);
  });

  it("refuses a Windows helper that the build never recorded, signature or not", () => {
    const root = temporaryRoot("vex-lighter-pack-win-unlisted-");
    const builtDir = fakeBuiltDir(root);
    rmSync(path.join(builtDir, "SHA256SUMS"));
    writeFileSync(
      path.join(builtDir, "SHA256SUMS"),
      `${createHash("sha256").update(pe("win32-x64", 0x8664)).digest("hex")}  vex-lighter-signer-win32-x64.exe\n`
    );
    const { context } = fakePackage(root, "win32", windowsHelpers);

    const result = verifyPackaged(root, context, builtDir, SIGNATURE_VALID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/vex-lighter-signer-win32-arm64\.exe is not listed in SHA256SUMS/);
  });

  /**
   * The signature escape hatch is WINDOWS-ONLY on purpose: on macOS the helper
   * reaches this hook before @electron/osx-sign touches anything, so altered
   * bytes there mean altered bytes, and a valid signature would prove only that
   * someone signed the wrong file.
   */
  it("keeps the digest as the only macOS provenance, whatever a signature would say", () => {
    const root = temporaryRoot("vex-lighter-pack-mac-signed-");
    const builtDir = fakeBuiltDir(root);
    const { context } = fakePackage(root, "darwin", [
      ["vex-lighter-signer-darwin-arm64", machoArm64("signed-somewhere-else")],
      fakeHelper("vex-lighter-signer-darwin-x64"),
    ]);

    const result = verifyPackaged(root, context, builtDir, SIGNATURE_VALID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/has sha256 .* but SHA256SUMS records/);
  });

  /**
   * THE WHOLE WINDOWS CHAIN, end to end, with no hand-written expectation in
   * the middle: the real staging script records the pre-sign content digest of
   * the helpers it staged, those staged bytes go through the signing
   * transformation electron-builder applies while copying, and the hook binds
   * the packaged result back to the build.
   */
  it("accepts the staged helper's signing transformation, and agrees with the staged record", () => {
    const root = temporaryRoot("vex-lighter-pack-win-staged-");
    const builtDir = fakeBuiltDir(root);
    expect(stage(root, "win")).toMatchObject({ ok: true });

    const staged = stagedDir(root);
    const packagedHelpers = ["vex-lighter-signer-win32-arm64.exe", "vex-lighter-signer-win32-x64.exe"].map(
      (name) => [name, authenticodeSigned(readFileSync(path.join(staged, name)))] as const,
    );
    const { context } = fakePackage(root, "win32", packagedHelpers);

    // The manifest the preflight wrote is a plain `<sha256>  <name>` record of
    // the PRE-SIGN content digest - the value the release log shows and the
    // coordinator can recompute.
    const manifest = readFileSync(path.join(staged, "AUTHENTICODE-SHA256SUMS"), "utf8");
    expect(manifest).toMatch(
      /^[0-9a-f]{64} {2}vex-lighter-signer-win32-arm64\.exe\n[0-9a-f]{64} {2}vex-lighter-signer-win32-x64\.exe\n$/,
    );

    expect(verifyPackaged(root, context, builtDir, SIGNATURE_VALID)).toMatchObject({
      ok: true,
      value: ["vex-lighter-signer-win32-arm64.exe", "vex-lighter-signer-win32-x64.exe"],
    });
  });

  it("refuses a package whose staged record disagrees with the build output", () => {
    const root = temporaryRoot("vex-lighter-pack-win-staged-drift-");
    const builtDir = fakeBuiltDir(root);
    expect(stage(root, "win")).toMatchObject({ ok: true });

    // The staging directory was rewritten after the preflight recorded it. No
    // supported path does this, which is exactly why it must be refused rather
    // than reconciled.
    const manifest = path.join(stagedDir(root), "AUTHENTICODE-SHA256SUMS");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(/^[0-9a-f]{64}/, "0".repeat(64)),
    );
    const { context } = fakePackage(root, "win32", signedWindowsHelpers());

    const result = verifyPackaged(root, context, builtDir, SIGNATURE_VALID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/AUTHENTICODE-SHA256SUMS records 0{64}/);
    expect(result.message).toMatch(/nothing may be signed on that/);
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

describe("the post-signing gate over the packaged Lighter signer", () => {
  /**
   * `host` and `inspectSignature` are the module's own test seam. Left out,
   * the gate runs against the real host and the real platform tool, which is
   * what the first three cases below assert; given, a Linux runner can drive
   * the Windows branch that only a signed release build otherwise reaches.
   */
  function verifySignature(
    root: string,
    platform: string,
    resources: string,
    options: { host?: string; inspectSignature?: string; builtDir?: string } = {},
  ): { issues: string[]; notes: string[] } {
    const overrides = [
      options.host === undefined ? undefined : `host: ${JSON.stringify(options.host)}`,
      options.inspectSignature === undefined ? undefined : `inspectSignature: ${options.inspectSignature}`,
      options.builtDir === undefined ? undefined : `builtDir: ${JSON.stringify(options.builtDir)}`,
    ].filter((entry) => entry !== undefined);
    const result = runDriver(root, `
      import { verifyPackagedLighterSignerSignature } from ${JSON.stringify(CHECK_PAYLOAD)};
      const payload = {
        target: { platform: ${JSON.stringify(platform)}, arch: "x64" },
        resources: ${JSON.stringify(resources)},
      };
      console.log(JSON.stringify({
        ok: true,
        value: verifyPackagedLighterSignerSignature(payload, { ${overrides.join(", ")} }),
      }));
    `);
    return result.value as { issues: string[]; notes: string[] };
  }

  /** A packaged Windows app executable beside `resources/`, as the gate looks for. */
  function fakeWindowsApp(appOutDir: string): void {
    writeBinary(path.join(appOutDir, "Vex.exe"), pe("the-app-itself", 0x8664));
  }

  it("fails when a packaged helper is absent, before it ever asks about signatures", () => {
    const root = temporaryRoot("vex-lighter-sig-missing-");
    const { appOutDir } = fakePackage(root, "linux", [fakeHelper("vex-lighter-signer-linux-arm64")]);

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

  /**
   * THE POST-SIGNING WINDOWS EVIDENCE. The release workflow runs
   * `pnpm run check:package` on the Windows job after electron-builder has
   * signed and published, and this is the branch it takes there. It cannot be
   * reached from a Linux runner without the seam, and it is precisely the
   * branch that decides whether a shipped Vex can spawn a signer the OS trusts.
   */
  it("passes a signed Windows app whose helpers are signed too", () => {
    const root = temporaryRoot("vex-lighter-sig-win-ok-");
    const builtDir = fakeBuiltDir(root);
    const { appOutDir } = fakePackage(root, "win32", signedWindowsHelpers());
    fakeWindowsApp(appOutDir);

    const { issues, notes } = verifySignature(root, "win32", path.join(appOutDir, "resources"), {
      host: "win32",
      builtDir,
      inspectSignature: SIGNATURE_VALID,
    });
    expect(issues).toEqual([]);
    expect(notes).toEqual([]);
  });

  /**
   * THE SAME HOLE, on the post-build side (Codex review, round 1, finding A1):
   * this gate used to ask only whether the helper carried a valid signature,
   * which every helper we have ever signed does.
   */
  it("fails a stale helper signed by the same publisher, before asking about signatures", () => {
    const root = temporaryRoot("vex-lighter-sig-win-stale-");
    const builtDir = fakeBuiltDir(root);
    const { appOutDir } = fakePackage(root, "win32", [
      ["vex-lighter-signer-win32-arm64.exe", authenticodeSigned(pe("last-release's-helper", 0xaa64))],
      ...signedWindowsHelpers().filter(([name]) => name.includes("x64")),
    ]);
    fakeWindowsApp(appOutDir);

    const { issues } = verifySignature(root, "win32", path.join(appOutDir, "resources"), {
      host: "win32",
      builtDir,
      // Every signature is Valid, exactly as it would be for our own old binary.
      inspectSignature: SIGNATURE_VALID,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/is NOT this build's vex-lighter-signer-win32-arm64\.exe/);
  });

  it("binds the Windows helpers from a Linux host too, where no signature tool exists", () => {
    const root = temporaryRoot("vex-lighter-sig-win-crosshost-");
    const builtDir = fakeBuiltDir(root);
    const { appOutDir } = fakePackage(root, "win32", [
      ["vex-lighter-signer-win32-arm64.exe", authenticodeSigned(pe("not-our-helper", 0xaa64))],
      ...signedWindowsHelpers().filter(([name]) => name.includes("x64")),
    ]);
    fakeWindowsApp(appOutDir);

    // No `host` and no `inspectSignature`: on this runner the signature branch
    // would only leave a note. Provenance does not need the platform tool, so
    // it is proven anyway.
    const { issues } = verifySignature(root, "win32", path.join(appOutDir, "resources"), { builtDir });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/is NOT this build's vex-lighter-signer-win32-arm64\.exe/);
  });

  it("refuses to pass a Windows payload it cannot bind to any build output", () => {
    const root = temporaryRoot("vex-lighter-sig-win-nobuild-");
    const { appOutDir } = fakePackage(root, "win32", signedWindowsHelpers());
    fakeWindowsApp(appOutDir);

    const { issues } = verifySignature(root, "win32", path.join(appOutDir, "resources"), {
      host: "win32",
      builtDir: path.join(root, "vex-app", "resources", "lighter-signer"),
      inspectSignature: SIGNATURE_VALID,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/cannot be bound to a build: missing .*SHA256SUMS/);
  });

  it("fails a SIGNED Windows app carrying an unsigned helper, and names the helper", () => {
    const root = temporaryRoot("vex-lighter-sig-win-bad-");
    const builtDir = fakeBuiltDir(root);
    const { appOutDir } = fakePackage(root, "win32", signedWindowsHelpers());
    fakeWindowsApp(appOutDir);

    // Everything is `Valid` except the helpers: the app vouches for itself, so
    // an unsigned helper beside it is a failure rather than an unsigned build.
    const { issues } = verifySignature(root, "win32", path.join(appOutDir, "resources"), {
      host: "win32",
      builtDir,
      inspectSignature:
        '(file) => ({ verified: !file.includes("vex-lighter-signer"), detail: "NotSigned" })',
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/vex-lighter-signer-win32-arm64\.exe is NOT signed/);
    expect(issues[1]).toMatch(/vex-lighter-signer-win32-x64\.exe is NOT signed/);
  });

  it("asserts nothing about helpers in an UNSIGNED Windows build, and says so", () => {
    const root = temporaryRoot("vex-lighter-sig-win-local-");
    const builtDir = fakeBuiltDir(root);
    const { appOutDir } = fakePackage(root, "win32", signedWindowsHelpers());
    fakeWindowsApp(appOutDir);

    const { issues, notes } = verifySignature(root, "win32", path.join(appOutDir, "resources"), {
      host: "win32",
      builtDir,
      inspectSignature: SIGNATURE_NOT_SIGNED,
    });
    expect(issues).toEqual([]);
    expect(notes.join(" ")).toMatch(/Vex\.exe itself carries no valid signature/);
  });

  it("fails closed when the Windows signature tool cannot be run at all", () => {
    const root = temporaryRoot("vex-lighter-sig-win-notool-");
    const builtDir = fakeBuiltDir(root);
    const { appOutDir } = fakePackage(root, "win32", signedWindowsHelpers());
    fakeWindowsApp(appOutDir);

    const { issues } = verifySignature(root, "win32", path.join(appOutDir, "resources"), {
      host: "win32",
      builtDir,
      inspectSignature: '() => { throw new Error("powershell is not on PATH"); }',
    });
    // A gate that reports "fine" when it could not look is worse than no gate.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/the signing tool for win32 is unavailable: powershell is not on PATH/);
  });
});
