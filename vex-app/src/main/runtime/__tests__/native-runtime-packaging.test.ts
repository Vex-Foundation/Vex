/**
 * THE PACKAGE-TIME GATES OVER THE NATIVE RUNTIME TREES, over synthetic trees.
 *
 * The bundled Postgres + pgvector and llama-server trees reach a package
 * through four owners, all driven here with the shipped code:
 *
 *   1. `scripts/native-runtime-artifact.mjs` - the target table, the lock, the
 *      lock-pinned tree listing and the tree rules;
 *   2. `scripts/stage-native-runtime.mjs` - the preflight that stages one
 *      target per arch, or fails before writing anything;
 *   3. `build/afterPack.mjs` `verifyPackagedNativeRuntime` - the packaged tree
 *      against the lock, before signing;
 *   4. `scripts/check-packaged-payload.mjs`
 *      `verifyPackagedNativeRuntimeSignatures` - the shipped tree after signing.
 *
 * The executables are FAKE - real Mach-O, ELF and PE headers over a few bytes -
 * as in the bridge and Lighter signer suites, whose structure this mirrors:
 * every gate reads each file's own header, so a header is what they can be
 * proven against, and a synthetic tree is the only way to exercise the macOS
 * and Windows shapes from any one runner. What a fake cannot prove - that the
 * published release really holds these names - is proven by the fetch, which
 * holds the real trees to the same rules (`requiredFiles`).
 *
 * The modules are ESM scripts under `vex-app/`, driven through a real `node`
 * child process, as in the sibling suites.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const APP_SCRIPTS = path.join(APP_ROOT, "scripts");
const ARTIFACT = path.join(APP_SCRIPTS, "native-runtime-artifact.mjs");
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

type Machine = "arm64" | "amd64";
type Platform = "darwin" | "linux" | "win32";

function macho(machine: Machine, payload: string): Buffer {
  const head = Buffer.alloc(64, 0);
  head.writeUInt32BE(0xcffaedfe, 0);
  head.writeUInt32LE(machine === "arm64" ? 0x0100000c : 0x01000007, 4);
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

function elf(machine: Machine, payload: string): Buffer {
  const head = Buffer.alloc(64, 0);
  head[0] = 0x7f;
  head.write("ELF", 1, "ascii");
  head[4] = 2;
  head[5] = 1;
  head.writeUInt16LE(machine === "arm64" ? 0xb7 : 0x3e, 18);
  return Buffer.concat([head, Buffer.from(payload, "utf8")]);
}

/** A structurally real PE32+ (see the Lighter signer suite for why it must be). */
function pe(machine: Machine, payload: string): Buffer {
  const SIZE_OF_HEADERS = 0x200;
  const body = Buffer.from(payload, "utf8");
  const rawSize = Math.ceil(Math.max(body.length, 1) / 0x200) * 0x200;
  const file = Buffer.alloc(SIZE_OF_HEADERS + rawSize, 0);
  file.write("MZ", 0, "ascii");
  file.writeUInt32LE(0x40, 0x3c);
  file.write("PE\0\0", 0x40, "ascii");
  const coff = 0x44;
  file.writeUInt16LE(machine === "arm64" ? 0xaa64 : 0x8664, coff);
  file.writeUInt16LE(1, coff + 2);
  file.writeUInt16LE(240, coff + 16);
  file.writeUInt16LE(0x22, coff + 18);
  const optional = coff + 20;
  file.writeUInt16LE(0x20b, optional);
  file.writeUInt32LE(SIZE_OF_HEADERS + rawSize, optional + 56);
  file.writeUInt32LE(SIZE_OF_HEADERS, optional + 60);
  file.writeUInt32LE(16, optional + 108);
  const sectionTable = optional + 240;
  file.write(".text\0\0\0", sectionTable, "ascii");
  file.writeUInt32LE(rawSize, sectionTable + 16);
  file.writeUInt32LE(SIZE_OF_HEADERS, sectionTable + 20);
  body.copy(file, SIZE_OF_HEADERS);
  return file;
}

/** The three edits Authenticode signing may make, as in the Lighter signer suite. */
function authenticodeSigned(unsigned: Buffer, certificate = "a-signature-blob"): Buffer {
  const file = Buffer.from(unsigned);
  const optional = 0x44 + 20;
  const dataDirectories = optional + 112;
  const blob = Buffer.alloc(Math.ceil((8 + certificate.length) / 8) * 8, 0);
  blob.writeUInt32LE(blob.length, 0);
  blob.writeUInt16LE(0x0200, 4);
  blob.writeUInt16LE(0x0002, 6);
  blob.write(certificate, 8, "ascii");
  file.writeUInt32LE(0xdeadbeef, optional + 64);
  file.writeUInt32LE(file.length, dataDirectories + 4 * 8);
  file.writeUInt32LE(blob.length, dataDirectories + 4 * 8 + 4);
  return Buffer.concat([file, blob]);
}

function moduleSpecifier(filePath: string): string {
  return JSON.stringify(pathToFileURL(filePath).href);
}

interface DriverResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly message?: string;
}

/** Run one body against the real modules in a real node process. */
function runDriver(root: string, body: string): DriverResult {
  const driver = path.join(root, `driver-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(driver, body);
  const stdout = execFileSync(process.execPath, [driver], { encoding: "utf8" });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as DriverResult;
}

function call(root: string, imports: string, expression: string): DriverResult {
  return runDriver(root, `
    ${imports}
    try {
      const value = await (async () => ${expression})();
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }));
    }
  `);
}

interface TargetRow {
  readonly name: string;
  readonly platform: Platform;
  readonly arch: "x64" | "arm64";
  readonly machine: { readonly postgres: Machine; readonly llama: Machine };
}

/** The real table and the real manifest, as the modules export them. */
function tableAndManifest(root: string, targetName: string): { target: TargetRow; required: string[] } {
  const result = call(
    root,
    `import { nativeRuntimeTargetNamed, requiredFiles } from ${moduleSpecifier(ARTIFACT)};`,
    `{ const target = nativeRuntimeTargetNamed(${JSON.stringify(targetName)}); return { target, required: requiredFiles(target, "0.8.7") }; }`,
  );
  if (!result.ok) throw new Error(result.message);
  return result.value as { target: TargetRow; required: string[] };
}

/** A file is an executable in these trees when it is a program or library. */
function isExecutablePath(rel: string): boolean {
  if (rel.startsWith("postgres/bin/") || rel.startsWith("postgres/lib/")) return true;
  return rel.startsWith("llama/") && !rel.includes("LICENSE") && !rel.startsWith("llama/licenses/");
}

function fakeBytes(target: TargetRow, rel: string): Buffer {
  if (rel.endsWith("vector.control")) return Buffer.from("comment = 'vector'\ndefault_version = '0.8.7'\n");
  if (!isExecutablePath(rel)) return Buffer.from(`data of ${rel}\n`);
  const machine = target.machine[rel.startsWith("postgres/") ? "postgres" : "llama"];
  if (target.platform === "darwin") return macho(machine, rel);
  if (target.platform === "linux") return elf(machine, rel);
  return pe(machine, rel);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture has no ${what}`);
  return value;
}

function writeFile(file: string, bytes: Buffer, executable: boolean): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  chmodSync(file, executable ? 0o755 : 0o644);
}

interface FakeRuntime {
  readonly appRoot: string;
  readonly target: TargetRow;
  readonly files: ReadonlyMap<string, Buffer>;
}

/**
 * A `vex-app/` in `root` with a lock pinning `targets`, each one fetched to
 * `resources/native-runtime/<target>/` with its listing, plus copies of the
 * modules the staging script imports (it resolves the app root from its own
 * location, so the code under test is byte-for-byte the shipped code).
 */
function fakeApp(root: string, targetNames: readonly string[]): Map<string, FakeRuntime> {
  const appRoot = path.join(root, "vex-app");
  const scripts = path.join(appRoot, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of ["native-runtime-artifact.mjs", "stage-native-runtime.mjs", "bridge-artifact.mjs", "lighter-signer-artifact.mjs"]) {
    writeFileSync(path.join(scripts, name), readFileSync(path.join(APP_SCRIPTS, name), "utf8"));
  }
  const runtimes = new Map<string, FakeRuntime>();
  const lockTargets: Record<string, unknown> = {};
  for (const name of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "win32-arm64"]) {
    const { target, required } = tableAndManifest(root, name);
    // Every required file, plus one the app does not name, which the listing
    // pins all the same.
    const paths = [...required, "postgres/share/postgresql/timezone/Europe/Warsaw"];
    const files = new Map(paths.map((rel) => [rel, fakeBytes(target, rel)] as const));
    const listing = [...files.entries()]
      .map(([rel, bytes]) => ({ rel, digest: sha256(bytes) }))
      .sort((a, b) => (a.rel < b.rel ? -1 : 1))
      .map((entry) => `${entry.digest}  ${entry.rel}\n`)
      .join("");
    lockTargets[name] = {
      asset: `vex-native-runtime-${name}.tar.xz`,
      sha256: sha256(`tarball of ${name}`),
      bytes: 1234,
      treeSha256: sha256(listing),
      files: files.size,
    };
    if (targetNames.includes(name)) {
      const dir = path.join(appRoot, "resources", "native-runtime", name);
      for (const [rel, bytes] of files) writeFile(path.join(dir, ...rel.split("/")), bytes, isExecutablePath(rel));
      writeFileSync(path.join(dir, "SHA256SUMS"), listing);
    }
    runtimes.set(name, { appRoot, target, files });
  }
  writeFileSync(
    path.join(appRoot, "native-runtime.lock.json"),
    JSON.stringify({
      release: "native-runtime-2026.10.17-1",
      baseUrl: "https://github.com/example/vex-native-runtime/releases/download/native-runtime-2026.10.17-1",
      targets: lockTargets,
    }),
  );
  return runtimes;
}

function stage(root: string, platform: string, arches: readonly string[]): DriverResult {
  const script = path.join(root, "vex-app", "scripts", "stage-native-runtime.mjs");
  return call(
    root,
    `import { stageNativeRuntime } from ${moduleSpecifier(script)};`,
    `stageNativeRuntime(${JSON.stringify(platform)}, ${JSON.stringify(arches)}).map((entry) => ({ target: entry.target.name, files: entry.files, executables: entry.executables, authenticode: entry.authenticode }))`,
  );
}

function filesUnder(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/** electron-builder's own numeric Arch enum, as afterPack receives it. */
const ARCH = { x64: 1, arm64: 3 } as const;

/**
 * A packaged app holding `runtime`'s trees exactly as extraResources copies
 * them, with `edit` applied to the file map first, and the runtime notices.
 */
function fakePackage(
  root: string,
  runtime: FakeRuntime,
  edit: (files: Map<string, Buffer>) => void = () => {},
): { context: Record<string, unknown>; resources: string } {
  const { target } = runtime;
  const appOutDir = path.join(root, "dist-electron", `${target.name}-unpacked`);
  const resources = target.platform === "darwin"
    ? path.join(appOutDir, "Vex.app", "Contents", "Resources")
    : path.join(appOutDir, "resources");
  const files = new Map(runtime.files);
  edit(files);
  for (const [rel, bytes] of files) writeFile(path.join(resources, ...rel.split("/")), bytes, isExecutablePath(rel));
  for (const notice of [
    "snowball-COPYING",
    "zlib-LICENSE",
    "msvc-runtime-NOTICE.txt",
    "gemma/NOTICE",
    "gemma/Gemma-Terms-of-Use.txt",
    "gemma/Gemma-Prohibited-Use-Policy.txt",
  ]) {
    writeFile(path.join(resources, "licenses", ...notice.split("/")), Buffer.from(notice), false);
  }
  return {
    resources,
    context: {
      electronPlatformName: target.platform,
      appOutDir,
      arch: ARCH[target.arch],
      packager: { appInfo: { productFilename: "Vex" } },
    },
  };
}

const SIGNATURE_TOOL_MUST_NOT_BE_CONSULTED = '(file) => { throw new Error("the signature tool was consulted for " + file); }';
const SIGNATURE_VALID = '() => ({ verified: true, detail: "Valid" })';
const SIGNATURE_NOT_SIGNED = '() => ({ verified: false, detail: "NotSigned" })';

function verifyPackaged(root: string, context: Record<string, unknown>, inspectSignature = SIGNATURE_TOOL_MUST_NOT_BE_CONSULTED): DriverResult {
  return call(
    root,
    `import { verifyPackagedNativeRuntime } from ${moduleSpecifier(AFTER_PACK)};`,
    `verifyPackagedNativeRuntime(${JSON.stringify(context)}, { appRoot: ${JSON.stringify(path.join(root, "vex-app"))}, inspectSignature: ${inspectSignature} })`,
  );
}

describe("the native runtime target table", () => {
  it("maps every packaging spelling to the release target, and the arm64 Windows runtime to x64 Postgres", () => {
    const root = temporaryRoot("vex-nr-table-");
    const result = call(
      root,
      `import { nativeRuntimeTargetFor } from ${moduleSpecifier(ARTIFACT)};`,
      `[["mac", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["win", "x64"], ["win32", "arm64"]].map(([p, a]) => { const t = nativeRuntimeTargetFor(p, a); return [t.name, t.machine.postgres, t.machine.llama]; })`,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        ["darwin-arm64", "arm64", "arm64"],
        ["darwin-x64", "amd64", "amd64"],
        ["linux-x64", "amd64", "amd64"],
        ["win32-x64", "amd64", "amd64"],
        ["win32-arm64", "amd64", "arm64"],
      ],
    });
  });

  it("refuses a platform/arch the release builds nothing for, by name", () => {
    const root = temporaryRoot("vex-nr-table-refuse-");
    const result = call(root, `import { nativeRuntimeTargetFor } from ${moduleSpecifier(ARTIFACT)};`, `nativeRuntimeTargetFor("linux", "arm64")`);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no linux-arm64 target/);
  });
});

describe("the native runtime lock", () => {
  it("accepts a lock that pins all five targets and refuses one that misses a target or carries a bad digest", () => {
    const root = temporaryRoot("vex-nr-lock-");
    fakeApp(root, []);
    const appRoot = path.join(root, "vex-app");
    const lockFile = path.join(appRoot, "native-runtime.lock.json");
    const read = (): DriverResult =>
      call(root, `import { readNativeRuntimeLock } from ${moduleSpecifier(ARTIFACT)};`, `readNativeRuntimeLock(${JSON.stringify(appRoot)}).release`);
    expect(read()).toEqual({ ok: true, value: "native-runtime-2026.10.17-1" });

    const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { targets: Record<string, Record<string, unknown>> };
    const valid = JSON.stringify(lock);
    delete lock.targets["win32-arm64"];
    writeFileSync(lockFile, JSON.stringify(lock));
    expect(read().message).toMatch(/no entry for win32-arm64/);

    const badDigest = JSON.parse(valid) as { targets: Record<string, Record<string, unknown>> };
    present(badDigest.targets["linux-x64"], "linux-x64").sha256 = "not-a-digest";
    writeFileSync(lockFile, JSON.stringify(badDigest));
    expect(read().message).toMatch(/linux-x64\.sha256 is not a sha256/);
  });
});

describe("staging the native runtime", () => {
  it("stages both macOS arches per arch, exactly the pinned files, with execute bits and an ignore rule", () => {
    const root = temporaryRoot("vex-nr-stage-mac-");
    const runtimes = fakeApp(root, ["darwin-arm64", "darwin-x64"]);
    const result = stage(root, "mac", ["arm64", "x64"]);
    expect(result.ok).toBe(true);

    for (const arch of ["arm64", "x64"] as const) {
      const runtime = present(runtimes.get(`darwin-${arch}`), `darwin-${arch}`);
      const resources = path.join(root, "vex-app", "resources");
      const staged = [
        ...filesUnder(path.join(resources, `postgres-${arch}`), "postgres/"),
        ...filesUnder(path.join(resources, `llama-${arch}`), "llama/"),
      ].sort();
      expect(staged).toEqual([...runtime.files.keys(), "postgres/.gitignore", "llama/.gitignore"].sort());
      const server = path.join(resources, `postgres-${arch}`, "bin", "postgres");
      expect(readFileSync(server)).toEqual(runtime.files.get("postgres/bin/postgres"));
      // NTFS keeps no execute bit; the macOS runtime is staged on macOS, where it does.
      if (process.platform !== "win32") {
        expect(execFileSync("stat", process.platform === "darwin" ? ["-f", "%Lp", server] : ["-c", "%a", server], { encoding: "utf8" }).trim()).toBe("755");
      }
    }
  });

  it("fails before writing anything when a fetched file differs from the listing, leaving the previous staging intact", () => {
    const root = temporaryRoot("vex-nr-stage-tampered-");
    fakeApp(root, ["darwin-arm64", "darwin-x64"]);
    expect(stage(root, "mac", ["arm64", "x64"]).ok).toBe(true);
    const resources = path.join(root, "vex-app", "resources");
    const before = filesUnder(path.join(resources, "llama-arm64")).sort();

    // The SECOND arch is the tampered one: the first must not be re-staged.
    writeFileSync(path.join(resources, "native-runtime", "darwin-x64", "llama", "llama-server"), macho("amd64", "something else"));
    rmSync(path.join(resources, "postgres-arm64", "bin", "initdb"));

    const result = stage(root, "mac", ["arm64", "x64"]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/darwin-x64 is not usable/);
    expect(result.message).toMatch(/llama\/llama-server: sha256 .* but the lock-pinned listing records/);
    expect(filesUnder(path.join(resources, "llama-arm64")).sort()).toEqual(before);
    expect(existsSync(path.join(resources, "postgres-arm64", "bin", "initdb"))).toBe(false);
  });

  it("refuses a fetched tree whose listing is not the one the lock pins", () => {
    const root = temporaryRoot("vex-nr-stage-listing-");
    fakeApp(root, ["linux-x64"]);
    const listing = path.join(root, "vex-app", "resources", "native-runtime", "linux-x64", "SHA256SUMS");
    writeFileSync(listing, `${readFileSync(listing, "utf8")}${"0".repeat(64)}  llama/extra.so\n`);

    const result = stage(root, "linux", ["x64"]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/SHA256SUMS hashes to .*, but native-runtime\.lock\.json pins/);
  });

  it("refuses an executable of the wrong machine even when the listing pins it", () => {
    const root = temporaryRoot("vex-nr-stage-arch-");
    const runtimes = fakeApp(root, []);
    // Rebuild the lock and the fetched tree with an x64 llama-server in the
    // arm64 tree: internally consistent, wrong for the target.
    const runtime = present(runtimes.get("darwin-arm64"), "darwin-arm64");
    const files = new Map(runtime.files);
    files.set("llama/llama-server", macho("amd64", "llama/llama-server"));
    const dir = path.join(root, "vex-app", "resources", "native-runtime", "darwin-arm64");
    for (const [rel, bytes] of files) writeFile(path.join(dir, ...rel.split("/")), bytes, isExecutablePath(rel));
    const listing = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, bytes]) => `${sha256(bytes)}  ${rel}\n`).join("");
    writeFileSync(path.join(dir, "SHA256SUMS"), listing);
    const lockFile = path.join(root, "vex-app", "native-runtime.lock.json");
    const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { targets: Record<string, Record<string, unknown>> };
    present(lock.targets["darwin-arm64"], "darwin-arm64").treeSha256 = sha256(listing);
    writeFileSync(lockFile, JSON.stringify(lock));

    const result = stage(root, "mac", ["arm64"]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/llama\/llama-server: header says darwin\/amd64; darwin-arm64 needs darwin\/arm64/);
  });

  it("stages win32-arm64 as x64 Postgres beside arm64 llama, and records every PE's Authenticode content digest", () => {
    const root = temporaryRoot("vex-nr-stage-win-");
    const runtimes = fakeApp(root, ["win32-x64", "win32-arm64"]);
    const result = stage(root, "win", ["x64", "arm64"]);
    expect(result.ok).toBe(true);
    const staged = result.value as Array<{ target: string; executables: number; authenticode: number }>;
    for (const entry of staged) expect(entry.authenticode).toBe(entry.executables);

    const resources = path.join(root, "vex-app", "resources");
    const manifest = readFileSync(path.join(resources, "postgres-arm64", "AUTHENTICODE-SHA256SUMS"), "utf8");
    expect(manifest).toMatch(/^[0-9a-f]{64} {2}postgres\/bin\/postgres\.exe$/m);
    expect(readFileSync(path.join(resources, "postgres-arm64", "bin", "postgres.exe"))).toEqual(
      present(runtimes.get("win32-arm64"), "win32-arm64").files.get("postgres/bin/postgres.exe"),
    );
  });
});

describe("verifying the packaged native runtime in the afterPack hook", () => {
  it("accepts exactly the pinned trees, by sha256, asking no signature tool (macOS, Linux)", () => {
    for (const name of ["darwin-arm64", "linux-x64"]) {
      const root = temporaryRoot(`vex-nr-pack-${name}-`);
      const runtime = present(fakeApp(root, [name]).get(name), name);
      const { context } = fakePackage(root, runtime);
      expect(verifyPackaged(root, context)).toMatchObject({ ok: true, value: { target: name, transformed: 0 } });
    }
  });

  it("refuses a staging file that leaked through the filter, and any file the lock does not pin", () => {
    const root = temporaryRoot("vex-nr-pack-extra-");
    const runtime = present(fakeApp(root, ["darwin-arm64"]).get("darwin-arm64"), "darwin-arm64");
    const { context } = fakePackage(root, runtime, (files) => {
      files.set("postgres/.gitignore", Buffer.from("*\n"));
      files.set("llama/libggml-cpu-haswell.so", macho("amd64", "another arch's backend"));
    });
    const result = verifyPackaged(root, context);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/postgres\/\.gitignore: not in the lock-pinned listing/);
    expect(result.message).toMatch(/llama\/libggml-cpu-haswell\.so: not in the lock-pinned listing/);
  });

  it("refuses a missing file and a changed one", () => {
    const root = temporaryRoot("vex-nr-pack-changed-");
    const runtime = present(fakeApp(root, ["linux-x64"]).get("linux-x64"), "linux-x64");
    const { context } = fakePackage(root, runtime, (files) => {
      files.delete("postgres/lib/postgresql/vector.so");
      files.set("postgres/bin/initdb", elf("amd64", "a different initdb"));
    });
    const result = verifyPackaged(root, context);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/postgres\/lib\/postgresql\/vector\.so: missing/);
    expect(result.message).toMatch(/postgres\/bin\/initdb: sha256 .* but the lock-pinned listing records/);
  });

  it("refuses a package without the runtime's notices", () => {
    const root = temporaryRoot("vex-nr-pack-notices-");
    const runtime = present(fakeApp(root, ["darwin-x64"]).get("darwin-x64"), "darwin-x64");
    const { context, resources } = fakePackage(root, runtime);
    rmSync(path.join(resources, "licenses", "gemma", "NOTICE"));
    const result = verifyPackaged(root, context);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/licenses\/gemma\/NOTICE: missing/);
  });

  it("accepts Windows PEs signed during the copy, bound by Authenticode content, under a valid signature", () => {
    const root = temporaryRoot("vex-nr-pack-win-signed-");
    const runtime = present(fakeApp(root, ["win32-arm64"]).get("win32-arm64"), "win32-arm64");
    expect(stage(root, "win", ["arm64"]).ok).toBe(true);
    let signedCount = 0;
    const { context } = fakePackage(root, runtime, (files) => {
      for (const [rel, bytes] of files) {
        if (rel.endsWith(".exe") || rel.endsWith(".dll")) {
          files.set(rel, authenticodeSigned(bytes));
          signedCount += 1;
        }
      }
    });
    expect(verifyPackaged(root, context, SIGNATURE_VALID)).toMatchObject({
      ok: true,
      value: { target: "win32-arm64", transformed: signedCount },
    });
  });

  it("accepts an unsigned Windows package by sha256 alone, asking no signature tool", () => {
    const root = temporaryRoot("vex-nr-pack-win-plain-");
    const runtime = present(fakeApp(root, ["win32-x64"]).get("win32-x64"), "win32-x64");
    const { context } = fakePackage(root, runtime);
    expect(verifyPackaged(root, context)).toMatchObject({ ok: true, value: { transformed: 0 } });
  });

  it("refuses a signed Windows PE that is not the pinned file, though its signature is valid", () => {
    const root = temporaryRoot("vex-nr-pack-win-stale-");
    const runtime = present(fakeApp(root, ["win32-x64"]).get("win32-x64"), "win32-x64");
    const { context } = fakePackage(root, runtime, (files) => {
      files.set("postgres/bin/libpq.dll", authenticodeSigned(pe("amd64", "libpq from an older release")));
    });
    const result = verifyPackaged(root, context, SIGNATURE_VALID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/postgres\/bin\/libpq\.dll: NOT the pinned file/);
  });

  it("refuses a rewritten Windows PE without a valid signature", () => {
    const root = temporaryRoot("vex-nr-pack-win-unsigned-");
    const runtime = present(fakeApp(root, ["win32-x64"]).get("win32-x64"), "win32-x64");
    const { context } = fakePackage(root, runtime, (files) => {
      files.set("llama/llama-server.exe", authenticodeSigned(present(files.get("llama/llama-server.exe"), "llama/llama-server.exe")));
    });
    const result = verifyPackaged(root, context, SIGNATURE_NOT_SIGNED);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/llama\/llama-server\.exe: rewritten on its way into the package and carries NO valid Authenticode signature/);
  });
});

/**
 * THE RELEASE ORDER, read out of the workflow: fetch (bytes against the lock),
 * stage (verified, per arch, the Windows pre-sign record), package (afterPack),
 * then `check:package` over the shipped trees, in each of the three jobs, for
 * every arch that job packages.
 */
describe("the release workflow's native runtime step order", () => {
  const yaml = readFileSync(path.join(APP_ROOT, "..", ".github", "workflows", "release.yml"), "utf8");

  function jobBlock(job: string): string {
    const start = yaml.indexOf(`\n  ${job}:\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = yaml.slice(start + 1);
    const next = /\n {2}[a-z0-9_-]+:\n/.exec(rest.slice(1));
    return next === null ? rest : rest.slice(0, next.index + 1);
  }

  const JOBS = [
    ["macos", "--platform mac", "--platform mac --arch arm64 --arch x64", "pnpm exec electron-builder --mac --arm64 --x64"],
    ["linux", "--platform linux", "--platform linux --arch x64", "pnpm exec electron-builder --linux"],
    ["windows", "--platform win", "--platform win --arch x64 --arch arm64", "pnpm exec electron-builder --win --x64 --arm64"],
  ] as const;

  for (const [job, fetchArgs, stageArgs, packageCommand] of JOBS) {
    it(`fetches, stages, packages, then checks the payload on ${job}`, () => {
      const block = jobBlock(job);
      const fetched = block.indexOf(`node scripts/fetch-native-runtime.mjs ${fetchArgs}`);
      const staged = block.indexOf(`node scripts/stage-native-runtime.mjs ${stageArgs}`);
      const packaged = block.indexOf(packageCommand);
      const checked = block.indexOf("pnpm run check:package");
      expect(fetched).toBeGreaterThan(-1);
      expect(staged).toBeGreaterThan(fetched);
      expect(packaged).toBeGreaterThan(staged);
      expect(checked).toBeGreaterThan(packaged);
    });
  }
});

describe("the post-signing native runtime gate (check:package)", () => {
  function check(root: string, resources: string, target: TargetRow, inspectSignature: string, host: string): DriverResult {
    return call(
      root,
      `import { verifyPackagedNativeRuntimeSignatures } from ${moduleSpecifier(CHECK_PAYLOAD)};`,
      `verifyPackagedNativeRuntimeSignatures(
        { target: { platform: ${JSON.stringify(target.platform)}, arch: ${JSON.stringify(target.arch)} }, resources: ${JSON.stringify(resources)} },
        { inspectSignature: ${inspectSignature}, host: ${JSON.stringify(host)}, appRoot: ${JSON.stringify(path.join(root, "vex-app"))} },
      )`,
    );
  }

  it("in a signed macOS app, accepts codesigned Mach-O files and refuses one that does not verify", () => {
    const root = temporaryRoot("vex-nr-check-mac-");
    const runtime = present(fakeApp(root, ["darwin-arm64"]).get("darwin-arm64"), "darwin-arm64");
    const { resources } = fakePackage(root, runtime, (files) => {
      // codesign rewrites every Mach-O; data files stay byte-identical.
      for (const [rel, bytes] of files) if (isExecutablePath(rel)) files.set(rel, Buffer.concat([bytes, Buffer.from("signature")]));
    });
    expect(check(root, resources, runtime.target, SIGNATURE_VALID, "darwin")).toMatchObject({ ok: true, value: { issues: [] } });

    const oneUnsigned = `(file) => ({ verified: !file.endsWith("libggml-cpu.so"), detail: "code object is not signed at all" })`;
    const result = check(root, resources, runtime.target, oneUnsigned, "darwin");
    expect((result.value as { issues: string[] }).issues.join("\n")).toMatch(/llama\/libggml-cpu\.so is NOT validly signed inside a SIGNED app/);
  });

  it("in an unsigned local macOS build, notes rather than fails", () => {
    const root = temporaryRoot("vex-nr-check-mac-unsigned-");
    const runtime = present(fakeApp(root, ["darwin-x64"]).get("darwin-x64"), "darwin-x64");
    const { resources } = fakePackage(root, runtime);
    const result = check(root, resources, runtime.target, SIGNATURE_NOT_SIGNED, "darwin");
    expect(result).toMatchObject({ ok: true, value: { issues: [] } });
    expect((result.value as { notes: string[] }).notes.join("\n")).toMatch(/unsigned local build/);
  });

  it("still holds a signed macOS package's data files to their sha256", () => {
    const root = temporaryRoot("vex-nr-check-mac-data-");
    const runtime = present(fakeApp(root, ["darwin-arm64"]).get("darwin-arm64"), "darwin-arm64");
    const { resources } = fakePackage(root, runtime, (files) => {
      files.set("postgres/share/postgresql/postgres.bki", Buffer.from("edited after packaging\n"));
    });
    const result = check(root, resources, runtime.target, SIGNATURE_VALID, "darwin");
    expect((result.value as { issues: string[] }).issues.join("\n")).toMatch(/postgres\.bki: sha256 .* but the lock-pinned listing records/);
  });

  it("in a signed Windows app, requires signed .exe files but accepts Microsoft-signed or lock-bound unsigned DLLs", () => {
    const root = temporaryRoot("vex-nr-check-win-");
    const runtime = present(fakeApp(root, ["win32-x64"]).get("win32-x64"), "win32-x64");
    const { resources } = fakePackage(root, runtime);
    writeFile(path.join(path.dirname(resources), "Vex.exe"), Buffer.from("MZ app"), true);

    const exeSignedDllsUnsigned = `(file) => file.endsWith(".dll") ? { verified: false, detail: "NotSigned" } : { verified: true, detail: "Valid" }`;
    expect(check(root, resources, runtime.target, exeSignedDllsUnsigned, "win32")).toMatchObject({ ok: true, value: { issues: [] } });

    const anExeUnsigned = `(file) => file.endsWith("Vex.exe") || file.endsWith(".dll") ? { verified: file.endsWith("Vex.exe"), detail: file.endsWith("Vex.exe") ? "Valid" : "NotSigned" } : { verified: false, detail: "NotSigned" }`;
    const unsignedExe = check(root, resources, runtime.target, anExeUnsigned, "win32");
    expect((unsignedExe.value as { issues: string[] }).issues.join("\n")).toMatch(/\.exe is NOT validly signed inside a SIGNED app/);

    const aDllTampered = `(file) => file.endsWith(".dll") ? { verified: false, detail: "HashMismatch" } : { verified: true, detail: "Valid" }`;
    const tampered = check(root, resources, runtime.target, aDllTampered, "win32");
    expect((tampered.value as { issues: string[] }).issues.join("\n")).toMatch(/\.dll is NOT validly signed inside a SIGNED app: HashMismatch/);

    const allValid = `() => ({ verified: true, detail: "Valid" })`;
    expect(check(root, resources, runtime.target, allValid, "win32")).toMatchObject({ ok: true, value: { issues: [] } });
  });

  it("verifies a Linux package by sha256 and consults no signature tool", () => {
    const root = temporaryRoot("vex-nr-check-linux-");
    const runtime = present(fakeApp(root, ["linux-x64"]).get("linux-x64"), "linux-x64");
    const { resources } = fakePackage(root, runtime);
    const result = check(root, resources, runtime.target, SIGNATURE_TOOL_MUST_NOT_BE_CONSULTED, "linux");
    expect(result).toMatchObject({ ok: true, value: { issues: [] } });
  });
});
