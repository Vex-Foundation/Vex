import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// GHSA-3gc7-fjrx-p6mg is a buffer overflow in bigint-buffer's NATIVE binding:
// `toBigIntLE` hands the caller's buffer to the N-API converter, which reads
// past it. The exception rests on three claims, and this verifier refuses to
// take any of them on trust:
//
//   1. the native binding is ABSENT from the installed package, so the loader
//      falls back to the pure-JavaScript implementation that has no overflow;
//   2. `pnpm.ignoredBuiltDependencies` still names bigint-buffer, so a future
//      install cannot silently compile the binding back in;
//   3. the only path from Vex into the package, @solana/buffer-layout-utils,
//      applies its layout factories at FIXED literal widths of 8 to 32 bytes.
//
// All three are read from the INSTALLED tree, then the reachable converters are
// exercised for real at both ends of that width range, so a Solana bump or a
// package.json edit that reopens the native path turns the gate red instead of
// silently widening the exception.

/** The four converters bigint-buffer exposes; the advisory is about the first. */
const CONVERTERS = ["toBigIntLE", "toBigIntBE", "toBufferLE", "toBufferBE"];

/** Widths the reviewed SPL layouts use. Anything outside is unreviewed. */
const MINIMUM_WIDTH = 8;
const MAXIMUM_WIDTH = 32;

/** The documented pure-JavaScript fallback notice from bigint-buffer's loader. */
const FALLBACK_NOTICE = /Failed to load bindings, pure JS will be used/;

export async function verifyBigIntBufferException(projectRoot) {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const splRequire = createRequire(projectRequire.resolve("@solana/spl-token"));
  const layoutEntry = splRequire.resolve("@solana/buffer-layout-utils");
  const layoutRequire = createRequire(layoutEntry);
  const bigintEntry = layoutRequire.resolve("bigint-buffer");
  const bigintRoot = packageRootOf(bigintEntry, "bigint-buffer");
  const layoutRoot = packageRootOf(layoutEntry, "@solana/buffer-layout-utils");

  // Claim 1a: no compiled artifact anywhere in the installed package. The
  // `bindings` loader only searches inside the package's own directory
  // (build/Release, out/Debug, prebuilds and siblings), so an empty result here
  // means there is nothing for it to find. Checked BEFORE the module is loaded,
  // so a present artifact is reported rather than executed.
  const artifacts = filesUnder(bigintRoot).filter((file) => file.endsWith(".node"));
  assert.deepEqual(artifacts, [],
    `The bigint-buffer native binding is built at ${artifacts.join(", ")}; the advisory's overflow is reachable`);

  // Claim 2: the install-script ban that keeps claim 1a true across installs.
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const ignoredBuilds = manifest.pnpm?.ignoredBuiltDependencies ?? [];
  assert(ignoredBuilds.includes("bigint-buffer"),
    "package.json no longer lists bigint-buffer under pnpm.ignoredBuiltDependencies; a future install could build the vulnerable binding");
  const allowedBuilds = manifest.pnpm?.onlyBuiltDependencies ?? [];
  assert(!allowedBuilds.includes("bigint-buffer"),
    "package.json permits bigint-buffer install scripts through pnpm.onlyBuiltDependencies; the native binding would be built");

  // Claim 3: every layout factory application in the installed
  // @solana/buffer-layout-utils fixes its width to a literal in the reviewed
  // range, so the buffer handed to toBigIntLE is never caller-sized.
  const importingModules = new Set();
  const widths = [];
  const FACTORY_CALL = /(?:\(\s*0\s*,\s*[\w$]+\.(bigInt|bigIntBE)\s*\)|(?<![\w$.])(bigInt|bigIntBE))\s*\(\s*([^)]*?)\s*\)/g;
  for (const file of filesUnder(path.join(layoutRoot, "lib"))) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const source = readFileSync(file, "utf8");
    if (/["']bigint-buffer["']/.test(source)) {
      const base = path.basename(file).replace(/\.m?js$/, "");
      assert.equal(base, "bigint",
        `An unreviewed @solana/buffer-layout-utils module imports bigint-buffer: ${file}`);
      for (const member of convertersReachedFrom(source)) {
        assert(CONVERTERS.includes(member),
          `Unreviewed bigint-buffer member reached from ${file}: ${member}`);
      }
      importingModules.add(base);
    }
    for (const match of source.matchAll(FACTORY_CALL)) {
      const argument = match[3];
      assert.match(argument, /^\d+$/,
        `@solana/buffer-layout-utils applies a bigint layout at a non-literal width in ${file}: ${match[0].trim()}`);
      const width = Number(argument);
      assert(width >= MINIMUM_WIDTH && width <= MAXIMUM_WIDTH,
        `@solana/buffer-layout-utils applies a bigint layout at ${width} bytes in ${file}, outside the reviewed ${MINIMUM_WIDTH} to ${MAXIMUM_WIDTH} byte range`);
      widths.push(width);
    }
  }
  assert(importingModules.has("bigint"),
    "The installed @solana/buffer-layout-utils no longer imports bigint-buffer; remove the exception");
  assert(widths.length > 0,
    "No fixed-width bigint layout was found in the installed @solana/buffer-layout-utils; reassess the exception");

  // Claim 1b: the loader itself reports the fallback. The module is required
  // fresh so its one-time notice is observed rather than served from cache,
  // which is the loader's own evidence that `converter` stayed undefined.
  delete layoutRequire.cache[bigintEntry];
  const notices = [];
  const originalWarn = console.warn;
  let bigintBuffer;
  try {
    console.warn = (...args) => { notices.push(args.map(String).join(" ")); };
    bigintBuffer = layoutRequire(bigintEntry);
  } finally {
    console.warn = originalWarn;
  }
  assert(notices.some((notice) => FALLBACK_NOTICE.test(notice)),
    `The installed bigint-buffer did not report its pure-JavaScript fallback (${notices.join(" | ") || "no notice"}); the native binding may be in use`);
  for (const name of CONVERTERS) {
    assert.equal(typeof bigintBuffer[name], "function",
      `The installed bigint-buffer does not export ${name}; reassess the exception`);
  }

  // The reachable converters, exercised for real at both ends of the reviewed
  // width range. A round trip proves the pure-JavaScript path computes, not
  // merely that it loaded.
  for (const [width, value] of [
    [MINIMUM_WIDTH, 0xfedc_ba98_7654_3210n],
    [MAXIMUM_WIDTH, (1n << 255n) + 0x0123_4567_89ab_cdefn],
  ]) {
    const encoded = bigintBuffer.toBufferLE(value, width);
    assert.equal(encoded.length, width,
      `bigint-buffer returned ${encoded.length} bytes for a ${width} byte layout`);
    assert.equal(bigintBuffer.toBigIntLE(encoded), value,
      `bigint-buffer did not round trip a ${width} byte value`);
  }
  assert.equal(bigintBuffer.toBufferLE(1n, MINIMUM_WIDTH)[0], 1,
    "bigint-buffer did not encode little-endian");
  assert.equal(bigintBuffer.toBigIntLE(Buffer.alloc(MAXIMUM_WIDTH)), 0n,
    "bigint-buffer did not decode a zeroed 32 byte layout as zero");
}

/**
 * The bigint-buffer members `source` can reach, for both module forms the
 * package ships: the CommonJS namespace binding produced by the TypeScript
 * emitter, and the ECMAScript named import list. A form neither pattern
 * recognises yields the whole specifier line, which then fails the caller's
 * allowlist rather than passing unread.
 */
function convertersReachedFrom(source) {
  const members = new Set();
  const cjsBinding = /(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["']bigint-buffer["']\s*\)/.exec(source);
  if (cjsBinding !== null) {
    for (const match of source.matchAll(new RegExp(`(?<![\\w$])${cjsBinding[1]}\\.([\\w$]+)`, "g"))) {
      members.add(match[1]);
    }
    return members;
  }
  const esmImport = /import\s*\{([^}]*)\}\s*from\s*["']bigint-buffer["']/.exec(source);
  if (esmImport !== null) {
    for (const specifier of esmImport[1].split(",")) {
      const name = specifier.trim().split(/\s+as\s+/)[0].trim();
      if (name.length > 0) members.add(name);
    }
    return members;
  }
  const line = source.split("\n").find((candidate) => /["']bigint-buffer["']/.test(candidate)) ?? "";
  members.add(`unreviewed import form: ${line.trim()}`);
  return members;
}

/** The directory of the installed package `name` that owns `entry`. */
function packageRootOf(entry, name) {
  let directory = path.dirname(entry);
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return directory;
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `Could not locate the installed ${name} package root from ${entry}`);
    directory = parent;
  }
}

/** Every file under `directory`, recursively; an absent directory yields none. */
function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(file));
    else files.push(file);
  }
  return files;
}
