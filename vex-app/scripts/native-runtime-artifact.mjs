/**
 * The Vex native runtime artifact: the bundled Postgres + pgvector tree and the
 * llama-server tree, which targets exist, what each tree must contain, where it
 * is fetched, staged and packaged, and the lock that pins its bytes.
 *
 * The trees are built and gated by `native-runtime/` and the
 * `native-runtime.yml` workflow, which publishes one
 * `vex-native-runtime-<target>.tar.xz` per target as a GitHub release. This
 * module is the app side of that contract and the ONE owner of:
 *
 *   - the target table: Electron platform/arch to the release's target name,
 *     and which machine each tree's executables are built for. Not always the
 *     packaged arch: PostgreSQL 18 has no MSVC ARM64 build, so the win32-arm64
 *     runtime is the x64 Postgres tree (run under Windows' x64 emulation) beside
 *     a native arm64 llama-server;
 *   - the per-target file manifest: what the app needs from each tree, by name;
 *   - the fetched, staged and packaged directories;
 *   - the lock (`native-runtime.lock.json`) and the tree listing it pins.
 *
 * THE PROVENANCE CHAIN. The lock is committed and records, per target, the
 * release asset's sha256 and byte count AND the sha256 of the tree's file
 * listing (`<sha256>  <path>` per file, sorted, the `sha256sum` format). The
 * fetch verifies the tarball against the lock before extracting anything, then
 * re-derives the listing from the extracted files and refuses it unless its
 * digest is the one the lock records. Every later gate - staging, the afterPack
 * hook, `check:package` - checks files against that listing, and the listing
 * against the lock, so each of them is bound to the committed lock and not to a
 * file some earlier step merely left behind.
 *
 * Signing rewrites executables on the way into a package, so the listing's
 * sha256 cannot settle every case: on macOS codesign runs after afterPack (so
 * afterPack still sees the build's bytes), and on Windows electron-builder
 * Authenticode-signs `.exe` and `.dll` files WHILE copying them in. For a PE the
 * binding is then the Authenticode CONTENT digest, the same rule and the same
 * code as the Lighter signer helper (`authenticodeContentSha256`).
 *
 * The header inspection (`inspectExecutable`) and the PE content digest are
 * imported, never restated: one answer per question in this repository.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import path from "node:path";

import { GOOS_BY_ELECTRON_PLATFORM, inspectExecutable } from "./bridge-artifact.mjs";
import { authenticodeContentSha256, sha256OfFile } from "./lighter-signer-artifact.mjs";

/** The committed lock, relative to `vex-app/`. */
export const NATIVE_RUNTIME_LOCK_FILE = "native-runtime.lock.json";

/** The two trees every target carries, and their packaged directory names. */
export const NATIVE_RUNTIME_COMPONENTS = Object.freeze(["postgres", "llama"]);

/** The tree listing the fetch writes beside each extracted target. */
export const NATIVE_RUNTIME_LISTING_FILE = "SHA256SUMS";

/** What the fetch records about the release a fetched tree came from. */
export const NATIVE_RUNTIME_RELEASE_FILE = "RELEASE.json";

/**
 * The PRE-SIGN Authenticode content digests of a staged Windows tree, one
 * manifest per staged component directory. See `authenticodeContentSha256`.
 */
export const NATIVE_RUNTIME_AUTHENTICODE_FILE = "AUTHENTICODE-SHA256SUMS";

/**
 * Files staging writes at the ROOT of a staged component directory that are
 * not part of the tree. The electron-builder profiles filter them out of
 * `extraResources`, and the packaged-tree gate refuses them if they arrive.
 */
export const NATIVE_RUNTIME_STAGING_METADATA = Object.freeze([".gitignore", NATIVE_RUNTIME_AUTHENTICODE_FILE]);

/**
 * The notices the runtime needs that its trees do not carry themselves,
 * committed under `resources/licenses/` and packaged to `licenses/`. The trees
 * carry PostgreSQL's COPYRIGHT, pgvector's and llama.cpp's licenses and the two
 * vendored llama.cpp licenses (see `requiredFiles`).
 */
export const NATIVE_RUNTIME_LICENSES = Object.freeze([
  "snowball-COPYING",
  "zlib-LICENSE",
  "msvc-runtime-NOTICE.txt",
  "gemma/NOTICE",
  "gemma/Gemma-Terms-of-Use.txt",
  "gemma/Gemma-Prohibited-Use-Policy.txt",
]);

/** The packaged location of those notices, relative to the resources directory. */
export const PACKAGED_LICENSES_SUBPATH = "licenses";

/**
 * EVERY TARGET THE RELEASE PUBLISHES, AND WHAT IT IS.
 *
 * `platform`/`arch` are Electron's names (what `process.platform` and
 * `process.arch` say, and what electron-builder packages for). `goos` and
 * `machine` are `inspectExecutable`'s vocabulary: the format and machine every
 * executable in that tree must declare in its own header.
 *
 * There is no linux-arm64 row: the native-runtime workflow builds none, so no
 * Linux arm64 package can carry the runtime.
 */
export const NATIVE_RUNTIME_TARGETS = Object.freeze([
  Object.freeze({
    name: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    goos: "darwin",
    machine: Object.freeze({ postgres: "arm64", llama: "arm64" }),
  }),
  Object.freeze({
    name: "darwin-x64",
    platform: "darwin",
    arch: "x64",
    goos: "darwin",
    machine: Object.freeze({ postgres: "amd64", llama: "amd64" }),
  }),
  Object.freeze({
    name: "linux-x64",
    platform: "linux",
    arch: "x64",
    goos: "linux",
    machine: Object.freeze({ postgres: "amd64", llama: "amd64" }),
  }),
  Object.freeze({
    name: "win32-x64",
    platform: "win32",
    arch: "x64",
    goos: "windows",
    machine: Object.freeze({ postgres: "amd64", llama: "amd64" }),
  }),
  // PostgreSQL 18.6 does not build with MSVC for ARM64 (upstream support is
  // PG 19), so this target ships the x64 Postgres tree, run under Windows' x64
  // emulation, beside a native arm64 llama-server (native-runtime/README.md).
  Object.freeze({
    name: "win32-arm64",
    platform: "win32",
    arch: "arm64",
    goos: "windows",
    machine: Object.freeze({ postgres: "amd64", llama: "arm64" }),
  }),
]);

const PLATFORM_BY_GOOS = Object.freeze({ darwin: "darwin", windows: "win32", linux: "linux" });

/**
 * Normalise any platform spelling the packaging chain uses (`mac`, `darwin`,
 * `win`, `win32`, `linux`) to Electron's, refusing an unknown one BY NAME.
 * electron-builder says `darwin` in an afterPack context and `mac` on its CLI.
 */
export function canonicalNativeRuntimePlatform(platform) {
  const goos = GOOS_BY_ELECTRON_PLATFORM[platform];
  if (goos === undefined) {
    throw new Error(
      `unknown packaging platform "${platform}"; the native runtime maps `
        + `${Object.keys(GOOS_BY_ELECTRON_PLATFORM).join(", ")}`
    );
  }
  return PLATFORM_BY_GOOS[goos];
}

/** The target for one Electron platform/arch pair, or a refusal naming the known ones. */
export function nativeRuntimeTargetFor(platform, arch) {
  const canonical = canonicalNativeRuntimePlatform(platform);
  const target = NATIVE_RUNTIME_TARGETS.find((entry) => entry.platform === canonical && entry.arch === arch);
  if (target === undefined) {
    throw new Error(
      `the native runtime has no ${canonical}-${arch} target; the release publishes `
        + `${NATIVE_RUNTIME_TARGETS.map((entry) => entry.name).join(", ")}`
    );
  }
  return target;
}

/** A target by its release name (`darwin-arm64`, ...), refusing an unknown one. */
export function nativeRuntimeTargetNamed(name) {
  const target = NATIVE_RUNTIME_TARGETS.find((entry) => entry.name === name);
  if (target === undefined) {
    throw new Error(
      `unknown native runtime target "${name}"; known targets are `
        + `${NATIVE_RUNTIME_TARGETS.map((entry) => entry.name).join(", ")}`
    );
  }
  return target;
}

/** Every target of one packaging platform: both macOS and both Windows arches, Linux x64. */
export function nativeRuntimeTargetsForPlatform(platform) {
  const canonical = canonicalNativeRuntimePlatform(platform);
  return NATIVE_RUNTIME_TARGETS.filter((target) => target.platform === canonical);
}

// ── The per-target manifest ─────────────────────────────────────────────────

/** The programs the runtime runs (6.1 of the plan); pg_upgrade arrives with PG 19. */
const POSTGRES_PROGRAMS = Object.freeze(["postgres", "initdb", "pg_ctl", "pg_controldata", "pg_dump", "pg_restore"]);

/**
 * Every server module the trees ship: the procedural language, the snowball
 * dictionaries, pgvector, and the encoding conversions initdb registers
 * (`pg_conversion`) and the server loads on first use of each.
 */
const POSTGRES_MODULES = Object.freeze([
  "plpgsql",
  "dict_snowball",
  "vector",
  "cyrillic_and_mic",
  "euc_cn_and_mic",
  "euc_jp_and_sjis",
  "euc_kr_and_mic",
  "euc_tw_and_big5",
  "euc2004_sjis2004",
  "latin_and_mic",
  "latin2_and_win1250",
  "utf8_and_big5",
  "utf8_and_cyrillic",
  "utf8_and_euc_cn",
  "utf8_and_euc_jp",
  "utf8_and_euc_kr",
  "utf8_and_euc_tw",
  "utf8_and_euc2004",
  "utf8_and_gb18030",
  "utf8_and_gbk",
  "utf8_and_iso8859_1",
  "utf8_and_iso8859",
  "utf8_and_johab",
  "utf8_and_sjis",
  "utf8_and_sjis2004",
  "utf8_and_uhc",
  "utf8_and_win",
]);

/**
 * What initdb reads to create a cluster, what `CREATE EXTENSION vector` reads,
 * and the zone the runtime's `postgresql.conf` names (`timezone = 'UTC'`,
 * src/main/runtime/native/postgres-conf.ts), relative to `share/postgresql/`.
 * The versioned `vector--<default_version>.sql` is added by `requiredFiles`
 * from the tree's own `vector.control`.
 */
const POSTGRES_SHARE = Object.freeze([
  "postgres.bki",
  "information_schema.sql",
  "snowball_create.sql",
  "sql_features.txt",
  "system_constraints.sql",
  "system_functions.sql",
  "system_views.sql",
  "extension/plpgsql.control",
  "extension/plpgsql--1.0.sql",
  "extension/vector.control",
  "timezonesets/Default",
  "timezone/UTC",
]);

/** The licenses the trees carry themselves (native-runtime/postgres/build.sh, llama/build.sh). */
const TREE_LICENSES = Object.freeze([
  "postgres/share/licenses/postgresql/COPYRIGHT",
  "postgres/share/licenses/pgvector/LICENSE",
  "llama/LICENSE",
  "llama/licenses/cpp-httplib-LICENSE",
  "llama/licenses/nlohmann-json-LICENSE",
]);

/**
 * ggml's x64 CPU backend variants. x64 trees carry all of them and ggml picks
 * the best one for the CPU at runtime (ggml_backend_load_best); arm64 trees
 * carry one baseline backend.
 */
const GGML_X64_CPU_VARIANTS = Object.freeze([
  "alderlake",
  "cannonlake",
  "cascadelake",
  "cooperlake",
  "haswell",
  "icelake",
  "ivybridge",
  "piledriver",
  "sandybridge",
  "sapphirerapids",
  "skylakex",
  "sse42",
  "x64",
  "zen4",
]);

/** The shared libraries llama-server links, by the name it links them under. */
const LLAMA_LIBRARIES = Object.freeze(["llama", "ggml", "ggml-base", "llama-common", "mtmd"]);

/**
 * Per-platform file naming, read off the built trees (native-runtime/out and
 * the published release), not guessed:
 *   - macOS: `libpq.5.dylib`, modules `.dylib`, llama libraries
 *     `lib<name>.0.dylib`, CPU backends `libggml-cpu[-<variant>].so`;
 *   - Linux: `libpq.so.5`, modules `.so`, `lib<name>.so.0`, backends `.so`;
 *   - Windows: `.exe` programs, `libpq.dll` in `bin/` (a DLL is found in its
 *     process's directory), modules `.dll`, llama libraries `<name>.dll`,
 *     backends `ggml-cpu-<variant>.dll`, and the app-local MSVC runtime.
 */
const NAMING = Object.freeze({
  darwin: Object.freeze({
    program: (name) => name,
    libpq: "postgres/lib/libpq.5.dylib",
    module: (name) => `${name}.dylib`,
    llamaLibrary: (name) => `lib${name}.0.dylib`,
    cpuBackend: (variant) => (variant === undefined ? "libggml-cpu.so" : `libggml-cpu-${variant}.so`),
    postgresRuntime: () => Object.freeze([]),
    llamaRuntime: () => Object.freeze([]),
  }),
  linux: Object.freeze({
    program: (name) => name,
    libpq: "postgres/lib/libpq.so.5",
    module: (name) => `${name}.so`,
    llamaLibrary: (name) => `lib${name}.so.0`,
    cpuBackend: (variant) => (variant === undefined ? "libggml-cpu.so" : `libggml-cpu-${variant}.so`),
    postgresRuntime: () => Object.freeze([]),
    llamaRuntime: () => Object.freeze([]),
  }),
  win32: Object.freeze({
    program: (name) => `${name}.exe`,
    libpq: "postgres/bin/libpq.dll",
    module: (name) => `${name}.dll`,
    llamaLibrary: (name) => `${name}.dll`,
    cpuBackend: (variant) => (variant === undefined ? "ggml-cpu.dll" : `ggml-cpu-${variant}.dll`),
    // The MSVC runtime, app-local: a clean Windows has no VC++
    // redistributable. Postgres (C) links vcruntime140 only; llama-server
    // (C++) also links msvcp140, and on x64 vcruntime140_1 (the x64-only FH4
    // exception handling runtime). Read off the native-runtime-2026.10.17-1
    // trees.
    postgresRuntime: () => Object.freeze(["vcruntime140.dll"]),
    llamaRuntime: (machine) => Object.freeze(
      machine === "amd64"
        ? ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]
        : ["msvcp140.dll", "vcruntime140.dll"]
    ),
  }),
});

/** Which CPU backends a target's llama tree carries. */
function cpuBackendVariants(target) {
  if (target.machine.llama === "amd64") return GGML_X64_CPU_VARIANTS;
  return [undefined];
}

/**
 * Every file the app needs from one target's trees, as listing paths
 * (`postgres/...`, `llama/...`). The tree may carry more (timezone data,
 * snowball stop words, pgvector upgrade scripts); the lock-bound listing is
 * what makes the rest exact.
 *
 * `vectorDefaultVersion` is the `default_version` the tree's own
 * `vector.control` declares: `CREATE EXTENSION vector` reads that file and then
 * needs exactly `vector--<default_version>.sql`, so that is the requirement.
 */
export function requiredFiles(target, vectorDefaultVersion) {
  const naming = NAMING[target.platform];
  const files = [
    ...POSTGRES_PROGRAMS.map((name) => `postgres/bin/${naming.program(name)}`),
    naming.libpq,
    ...POSTGRES_MODULES.map((name) => `postgres/lib/postgresql/${naming.module(name)}`),
    ...POSTGRES_SHARE.map((name) => `postgres/share/postgresql/${name}`),
    ...naming.postgresRuntime(target.machine.postgres).map((name) => `postgres/bin/${name}`),
    `llama/${naming.program("llama-server")}`,
    ...LLAMA_LIBRARIES.map((name) => `llama/${naming.llamaLibrary(name)}`),
    ...cpuBackendVariants(target).map((variant) => `llama/${naming.cpuBackend(variant)}`),
    ...naming.llamaRuntime(target.machine.llama).map((name) => `llama/${name}`),
    ...TREE_LICENSES,
  ];
  if (vectorDefaultVersion !== undefined) {
    files.push(`postgres/share/postgresql/extension/vector--${vectorDefaultVersion}.sql`);
  }
  return files;
}

/** The `default_version` a `vector.control` declares, or a refusal naming the file. */
export function vectorDefaultVersion(controlFile) {
  if (!existsSync(controlFile)) throw new Error(`missing: ${controlFile}`);
  const match = /^\s*default_version\s*=\s*'([^']+)'\s*$/m.exec(readFileSync(controlFile, "utf8"));
  if (match === null) throw new Error(`${controlFile} declares no default_version`);
  return match[1];
}

// ── Directories ─────────────────────────────────────────────────────────────

/** Where `scripts/fetch-native-runtime.mjs` keeps downloads and extracted trees. */
export function fetchedNativeRuntimeRoot(appRoot) {
  return path.join(appRoot, "resources", "native-runtime");
}

/** One target's extracted trees: `<root>/<target>/{postgres,llama}` plus its listing. */
export function fetchedNativeRuntimeDir(appRoot, target) {
  return path.join(fetchedNativeRuntimeRoot(appRoot), target.name);
}

/**
 * The staging directory for ONE component and ONE Electron arch, which
 * `extraResources` copies from (`resources/postgres-${arch}` -> `postgres`).
 * Per arch for the bridge's reason: the macOS and Windows jobs package both
 * arches in one electron-builder invocation, and app-builder-lib expands
 * `${arch}` in `from` per packaged arch.
 */
export function stagedNativeRuntimeDir(appRoot, component, electronArch) {
  return path.join(appRoot, "resources", `${component}-${electronArch}`);
}

/** The packaged component directories under an app's resources directory. */
export function packagedNativeRuntimeDirs(resourcesDir) {
  return Object.fromEntries(NATIVE_RUNTIME_COMPONENTS.map((component) => [component, path.join(resourcesDir, component)]));
}

// ── The lock ────────────────────────────────────────────────────────────────

const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_NAME = /^native-runtime-\d{4}\.\d{2}\.\d{2}-\d+$/;

/** The release asset name for one target, as the publish job names it. */
export function nativeRuntimeAssetName(target) {
  return `vex-native-runtime-${target.name}.tar.xz`;
}

/**
 * Read and validate the committed lock, refusing any field that does not make
 * sense by name. Returns `{ release, baseUrl, targets: { <name>: entry } }`
 * with every target of the table present and nothing else.
 *
 * `baseUrl` is the directory the assets are downloaded from
 * (`<baseUrl>/<asset>`). While it is a GitHub release URL on a private
 * repository the fetch resolves the asset through the GitHub API with a token;
 * a public location needs nothing.
 */
export function readNativeRuntimeLock(appRoot) {
  const file = path.join(appRoot, NATIVE_RUNTIME_LOCK_FILE);
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`);
  }
  return validateNativeRuntimeLock(lock, file);
}

/** The lock's shape, checked field by field. Exported for the lock writer and tests. */
export function validateNativeRuntimeLock(lock, label = NATIVE_RUNTIME_LOCK_FILE) {
  const refuse = (reason) => {
    throw new Error(`${label}: ${reason}`);
  };
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) refuse("not an object");
  if (typeof lock.release !== "string" || !RELEASE_NAME.test(lock.release)) {
    refuse(`release must look like native-runtime-2026.10.17-1, got ${JSON.stringify(lock.release)}`);
  }
  if (typeof lock.baseUrl !== "string" || !lock.baseUrl.startsWith("https://")) {
    refuse(`baseUrl must be an https URL, got ${JSON.stringify(lock.baseUrl)}`);
  }
  if (lock.targets === null || typeof lock.targets !== "object") refuse("no targets");
  const names = NATIVE_RUNTIME_TARGETS.map((target) => target.name);
  for (const name of Object.keys(lock.targets)) {
    if (!names.includes(name)) refuse(`target ${name} is not one this app packages (${names.join(", ")})`);
  }
  for (const target of NATIVE_RUNTIME_TARGETS) {
    const entry = lock.targets[target.name];
    if (entry === undefined) refuse(`no entry for ${target.name}`);
    if (entry.asset !== nativeRuntimeAssetName(target)) {
      refuse(`${target.name}.asset must be ${nativeRuntimeAssetName(target)}, got ${JSON.stringify(entry.asset)}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) refuse(`${target.name}.sha256 is not a sha256`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) refuse(`${target.name}.bytes is not a positive integer`);
    if (typeof entry.treeSha256 !== "string" || !SHA256.test(entry.treeSha256)) {
      refuse(`${target.name}.treeSha256 is not a sha256`);
    }
    if (!Number.isSafeInteger(entry.files) || entry.files <= 0) refuse(`${target.name}.files is not a positive integer`);
  }
  return lock;
}

// ── The tree listing ────────────────────────────────────────────────────────

/** Lowercase hex sha256 of a string or buffer. */
export function sha256OfText(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Every regular file under the component directories, as sorted listing paths
 * (`postgres/bin/postgres`). Anything that is not a regular file or a
 * directory - a symlink, a device, a socket - is REFUSED: the published trees
 * carry no links (llama/build.sh copies the file behind each one), and a link
 * inside a package is a path that can point anywhere.
 *
 * `allowStagingMetadata` skips the staging files at a component's root (a
 * staged directory legitimately holds them); everywhere else they are files
 * like any other, so a packaged tree that carries one fails the exact-set
 * check.
 */
export function listTreeFiles(componentDirs, { allowStagingMetadata = false } = {}) {
  const found = [];
  for (const component of NATIVE_RUNTIME_COMPONENTS) {
    const root = componentDirs[component];
    if (root === undefined || !existsSync(root)) throw new Error(`missing ${component} tree at ${root}`);
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        const rel = `${prefix}/${entry.name}`;
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          walk(full, rel);
        } else if (stat.isFile()) {
          if (allowStagingMetadata && dir === root && NATIVE_RUNTIME_STAGING_METADATA.includes(entry.name)) continue;
          found.push({ path: rel, file: full, mode: stat.mode });
        } else {
          throw new Error(`${full} is not a regular file or directory; the runtime trees carry no links`);
        }
      }
    };
    walk(root, component);
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Render a listing in the `sha256sum` format, sorted by path (byte order). */
export function renderTreeListing(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted.map((entry) => `${entry.digest}  ${entry.path}\n`).join("");
}

/**
 * Parse a listing, refusing a malformed line, a duplicate, or a path that
 * could leave the tree (absolute, `..`, a backslash), by line number.
 */
export function parseTreeListing(text, label) {
  const digests = new Map();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 && index === lines.length - 1) continue;
    const match = /^([0-9a-f]{64}) {2}((?:postgres|llama)\/[^\s\\]+)$/.exec(line);
    if (match === null || match[2].split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`${label} line ${index + 1} is not a \`<sha256>  <postgres|llama>/<path>\` record: ${line}`);
    }
    if (digests.has(match[2])) throw new Error(`${label} lists ${match[2]} twice`);
    digests.set(match[2], match[1]);
  }
  if (digests.size === 0) throw new Error(`${label} lists no file; an empty listing verifies nothing`);
  return digests;
}

/**
 * The fetched listing for one target, authenticated against the lock: its
 * digest must be the lock's `treeSha256` and its length the lock's `files`.
 * Returns the Map from listing path to sha256.
 */
export function readFetchedListing(appRoot, target, lock) {
  const file = path.join(fetchedNativeRuntimeDir(appRoot, target), NATIVE_RUNTIME_LISTING_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `missing ${file}. Fetch the runtime first: node scripts/fetch-native-runtime.mjs --target ${target.name}`
    );
  }
  const text = readFileSync(file);
  const entry = lock.targets[target.name];
  const digest = sha256OfText(text);
  if (digest !== entry.treeSha256) {
    throw new Error(
      `${file} hashes to ${digest}, but ${NATIVE_RUNTIME_LOCK_FILE} pins ${entry.treeSha256} for `
        + `${target.name} (${lock.release}). Re-fetch: node scripts/fetch-native-runtime.mjs --target ${target.name}`
    );
  }
  const listing = parseTreeListing(text.toString("utf8"), file);
  if (listing.size !== entry.files) {
    throw new Error(`${file} lists ${listing.size} files; ${NATIVE_RUNTIME_LOCK_FILE} records ${entry.files}`);
  }
  return listing;
}

// ── Inspection ──────────────────────────────────────────────────────────────

/**
 * The executable format a file's first bytes declare, or `undefined` for data
 * (SQL, timezone data, licenses). Only the magic is read here; everything that
 * claims a format is then held to `inspectExecutable`'s full answer.
 */
export function executableFormatOf(file) {
  const head = Buffer.alloc(4);
  const fd = openSync(file, "r");
  let read;
  try {
    read = readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 2) return undefined;
  if (read === 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "elf";
  if (read === 4) {
    const magic = head.readUInt32BE(0);
    // Both byte orders of 32- and 64-bit Mach-O, and the universal header,
    // so a 32-bit or fat file is caught by inspectExecutable rather than
    // passing as data.
    if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe].includes(magic)) return "macho";
  }
  if (head[0] === 0x4d && head[1] === 0x5a) return "pe";
  return undefined;
}

/**
 * Hold one tree (fetched, staged or packaged) to its target and listing, and
 * return `{ issues, files }`. Collects rather than throws, so one run names
 * every problem; callers decide whether an issue is fatal.
 *
 *   1. EXACT SET: the files present are exactly the listing's - none missing,
 *      none extra. An extra file is a foreign-arch leftover, a staging file
 *      that leaked into a package, or anything else nobody pinned.
 *   2. MANIFEST: every file the app needs (`requiredFiles`) is in the listing.
 *   3. HEADERS: every file whose magic declares an executable format is, by
 *      `inspectExecutable`, the target's format and its component's machine.
 *   4. MODE: on a POSIX target inspected from a POSIX host, every executable is
 *      executable by its owner.
 *   5. BYTES, per `signed`:
 *        - `false`: every file's sha256 equals the listing;
 *        - `"codesign"` (a macOS package after signing): Mach-O files are
 *          exempt, since codesign rewrote them and their signature is checked
 *          separately; every other file must still match;
 *        - `"authenticode"` (a Windows package): a PE whose sha256 differs must
 *          have the Authenticode content digest of the same file in
 *          `sourceDirs` (whose sha256 is itself checked against the listing);
 *          every other file must match. Such files are returned with
 *          `transformed: true`, so the caller can ask for a valid signature.
 */
export function evaluateNativeRuntimeTree(componentDirs, target, listing, {
  allowStagingMetadata = false,
  signed = false,
  sourceDirs,
  host = process.platform,
} = {}) {
  const issues = [];
  const files = [];
  let present;
  try {
    present = listTreeFiles(componentDirs, { allowStagingMetadata });
  } catch (error) {
    return { issues: [error.message], files };
  }

  const presentPaths = new Set(present.map((entry) => entry.path));
  for (const listed of listing.keys()) {
    if (!presentPaths.has(listed)) issues.push(`${listed}: missing (the lock-pinned listing names it)`);
  }
  for (const entry of present) {
    if (!listing.has(entry.path)) issues.push(`${entry.path}: not in the lock-pinned listing; nothing pinned this file`);
  }

  let vectorVersion;
  const control = componentDirs.postgres && path.join(componentDirs.postgres, "share", "postgresql", "extension", "vector.control");
  try {
    vectorVersion = vectorDefaultVersion(control);
  } catch (error) {
    issues.push(error.message);
  }
  for (const required of requiredFiles(target, vectorVersion)) {
    if (!listing.has(required)) issues.push(`${required}: required by the app but absent from the listing`);
  }

  for (const entry of present) {
    const expected = listing.get(entry.path);
    if (expected === undefined) continue;
    const component = entry.path.split("/")[0];
    const format = executableFormatOf(entry.file);
    let inspection;
    if (format !== undefined) {
      try {
        inspection = inspectExecutable(entry.file);
        const machine = target.machine[component];
        if (inspection.goos !== target.goos || inspection.arch !== machine) {
          issues.push(
            `${entry.path}: header says ${inspection.goos}/${inspection.arch}; ${target.name} needs `
              + `${target.goos}/${machine} in its ${component} tree`
          );
        }
      } catch (error) {
        issues.push(`${entry.path}: ${error.message}`);
      }
      if (target.platform !== "win32" && host !== "win32" && (entry.mode & constants.S_IXUSR) === 0) {
        issues.push(`${entry.path}: an executable without its execute bit (mode ${(entry.mode & 0o777).toString(8)})`);
      }
    }

    if (signed === "codesign" && format === "macho") {
      files.push({ path: entry.path, file: entry.file, format, transformed: undefined });
      continue;
    }
    const digest = sha256OfFile(entry.file);
    if (digest === expected) {
      files.push({ path: entry.path, file: entry.file, format, transformed: false, digest });
      continue;
    }
    if (signed === "authenticode" && format === "pe") {
      const source = sourceDirs?.[component] && path.join(sourceDirs[component], ...entry.path.split("/").slice(1));
      if (source === undefined || !existsSync(source)) {
        issues.push(
          `${entry.path}: rewritten on its way into the package (sha256 ${digest}, the listing pins ${expected}) `
            + `and the fetched source ${source ?? "(none given)"} is not there to bind it back to`
        );
        continue;
      }
      const sourceDigest = sha256OfFile(source);
      if (sourceDigest !== expected) {
        issues.push(`${source}: sha256 ${sourceDigest}, but the listing pins ${expected}; re-fetch the runtime`);
        continue;
      }
      try {
        const content = authenticodeContentSha256(entry.file);
        const expectedContent = authenticodeContentSha256(source);
        if (content !== expectedContent) {
          issues.push(
            `${entry.path}: NOT the pinned file. Its Authenticode content digest is ${content}; the pinned `
              + `file's is ${expectedContent}. Signing cannot change that digest, so this is a different executable.`
          );
          continue;
        }
        files.push({ path: entry.path, file: entry.file, format, transformed: true, digest, content });
      } catch (error) {
        issues.push(`${entry.path}: ${error.message}`);
      }
      continue;
    }
    issues.push(`${entry.path}: sha256 ${digest}, but the lock-pinned listing records ${expected}`);
  }
  return { issues, files };
}

/** Render `<digest>  <path>` records for a component's AUTHENTICODE manifest. */
export function renderAuthenticodeManifest(entries) {
  return renderTreeListing(entries);
}

/** Read a staged component's AUTHENTICODE manifest, or `undefined` when there is none. */
export function readAuthenticodeManifest(stagedDir) {
  const file = path.join(stagedDir, NATIVE_RUNTIME_AUTHENTICODE_FILE);
  if (!existsSync(file)) return undefined;
  return parseTreeListing(readFileSync(file, "utf8"), file);
}
