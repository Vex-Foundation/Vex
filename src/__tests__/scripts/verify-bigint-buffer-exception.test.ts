/**
 * The bigint-buffer reachability verifier, driven against SYNTHETIC installed
 * graphs.
 *
 * The exception for bigint-buffer 1.1.5 (GHSA-3gc7-fjrx-p6mg) is not "the
 * advisory does not apply to us" as an opinion; it is three claims about the
 * installed tree: no compiled native binding, an install-script ban that keeps
 * it that way, and fixed literal layout widths of 8 to 32 bytes in
 * @solana/buffer-layout-utils. This suite builds throwaway node_modules trees
 * that each break exactly one of those claims and asserts the verifier refuses,
 * so weakening it to "bigint-buffer is installed somewhere" turns these red.
 *
 * The real installed graph is exercised by `pnpm run audit:deps`, which calls
 * the same function with the workspace root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, beforeAll } from "vitest";

type ReachabilityVerifier = (projectRoot: string) => Promise<void>;

/**
 * The gate scripts are plain ESM with no type declarations. Resolving the
 * specifier at run time keeps the seam typed here, instead of suppressing the
 * checker over a static import.
 */
let verifyBigIntBufferException: ReachabilityVerifier;

beforeAll(async () => {
  const specifier = new URL("../../../scripts/verify-bigint-buffer-exception.mjs", import.meta.url).href;
  const loaded = (await import(specifier)) as { readonly verifyBigIntBufferException: ReachabilityVerifier };
  verifyBigIntBufferException = loaded.verifyBigIntBufferException;
});

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

/** The reviewed shape: fixed literal widths, exactly as Solana ships them. */
const COMPLIANT_LAYOUT = [
  'const bigint_buffer_1 = require("bigint-buffer");',
  "const bigInt = (length) => (property) => ({ length, property });",
  "const bigIntBE = (length) => (property) => ({ length, property });",
  "exports.decodeLE = (src) => bigint_buffer_1.toBigIntLE(Buffer.from(src));",
  "exports.encodeLE = (value, length) => bigint_buffer_1.toBufferLE(value, length);",
  "exports.u64 = (0, exports.bigInt)(8);",
  "exports.u128 = (0, exports.bigInt)(16);",
  "exports.u256 = (0, exports.bigIntBE)(32);",
  "",
].join("\n");

/** The installed loader's own fallback branch, verbatim in behaviour. */
const PURE_JS_BIGINT_BUFFER = [
  "'use strict';",
  "let converter;",
  "try { converter = require('./missing-binding.node'); }",
  "catch (e) { console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)'); }",
  "function toBigIntLE(buf) {",
  "  const reversed = Buffer.from(buf); reversed.reverse();",
  "  const hex = reversed.toString('hex');",
  "  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);",
  "}",
  "function toBigIntBE(buf) {",
  "  const hex = buf.toString('hex');",
  "  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);",
  "}",
  "function toBufferLE(num, width) {",
  "  const hex = num.toString(16);",
  "  const buffer = Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');",
  "  buffer.reverse();",
  "  return buffer;",
  "}",
  "function toBufferBE(num, width) {",
  "  const hex = num.toString(16);",
  "  return Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');",
  "}",
  "exports.toBigIntLE = toBigIntLE;",
  "exports.toBigIntBE = toBigIntBE;",
  "exports.toBufferLE = toBufferLE;",
  "exports.toBufferBE = toBufferBE;",
  "",
].join("\n");

interface GraphOptions {
  /** The installed @solana/buffer-layout-utils bigint module source. */
  readonly layoutSource?: string;
  /** Extra files, relative to the sandbox root, written verbatim. */
  readonly extraFiles?: Readonly<Record<string, string>>;
  /** The `pnpm` block of the sandbox package.json; omit for the reviewed one. */
  readonly pnpm?: unknown;
}

/**
 * A minimal installed graph:
 * project -> @solana/spl-token -> @solana/buffer-layout-utils -> bigint-buffer.
 */
function buildGraph(options: GraphOptions = {}): string {
  const sandbox = mkdtempSync(path.join(tmpdir(), "vex-bigint-buffer-exception-"));
  sandboxes.push(sandbox);
  const write = (relative: string, contents: string): void => {
    const absolute = path.join(sandbox, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  };
  write("package.json", JSON.stringify({
    name: "sandbox",
    version: "0.0.0",
    pnpm: "pnpm" in options ? options.pnpm : { ignoredBuiltDependencies: ["bigint-buffer"] },
  }));
  write("node_modules/@solana/spl-token/package.json", JSON.stringify({ name: "@solana/spl-token", version: "0.4.16", main: "index.js" }));
  write("node_modules/@solana/spl-token/index.js", "module.exports = require('@solana/buffer-layout-utils');\n");
  write("node_modules/@solana/buffer-layout-utils/package.json", JSON.stringify({
    name: "@solana/buffer-layout-utils",
    version: "0.2.0",
    main: "lib/cjs/index.js",
  }));
  write("node_modules/@solana/buffer-layout-utils/lib/cjs/index.js", "module.exports = require('./bigint');\n");
  write("node_modules/@solana/buffer-layout-utils/lib/cjs/bigint.js", options.layoutSource ?? COMPLIANT_LAYOUT);
  write("node_modules/bigint-buffer/package.json", JSON.stringify({ name: "bigint-buffer", version: "1.1.5", main: "dist/node.js" }));
  write("node_modules/bigint-buffer/dist/node.js", PURE_JS_BIGINT_BUFFER);
  for (const [relative, contents] of Object.entries(options.extraFiles ?? {})) write(relative, contents);
  return sandbox;
}

describe("verify-bigint-buffer-exception", () => {
  it("accepts a graph with no native binding, the install ban, and fixed literal widths", async () => {
    await expect(verifyBigIntBufferException(buildGraph())).resolves.toBeUndefined();
  });

  it("refuses a graph whose native binding has been built", async () => {
    const sandbox = buildGraph({
      extraFiles: { "node_modules/bigint-buffer/build/Release/bigint_buffer.node": "not a real binding" },
    });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/native binding is built/);
  });

  it("refuses a graph that no longer bans the bigint-buffer install script", async () => {
    const sandbox = buildGraph({ pnpm: { ignoredBuiltDependencies: ["utf-8-validate"] } });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/ignoredBuiltDependencies/);
  });

  it("refuses a graph with no pnpm build policy at all", async () => {
    const sandbox = buildGraph({ pnpm: undefined });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/ignoredBuiltDependencies/);
  });

  it("refuses a graph that permits the bigint-buffer install script", async () => {
    const sandbox = buildGraph({
      pnpm: { ignoredBuiltDependencies: ["bigint-buffer"], onlyBuiltDependencies: ["bigint-buffer"] },
    });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/onlyBuiltDependencies/);
  });

  it("refuses a call site whose layout width is dynamic", async () => {
    const source = COMPLIANT_LAYOUT.replace(
      "exports.u64 = (0, exports.bigInt)(8);",
      "exports.uDynamic = (width) => (0, exports.bigInt)(width);",
    );
    await expect(verifyBigIntBufferException(buildGraph({ layoutSource: source })))
      .rejects.toThrow(/non-literal width/);
  });

  it("refuses a call site whose layout width is outside the reviewed range", async () => {
    const source = COMPLIANT_LAYOUT.replace(
      "exports.u256 = (0, exports.bigIntBE)(32);",
      "exports.u512 = (0, exports.bigIntBE)(64);",
    );
    await expect(verifyBigIntBufferException(buildGraph({ layoutSource: source })))
      .rejects.toThrow(/outside the reviewed 8 to 32 byte range/);
  });

  it("refuses an unreviewed module that reaches bigint-buffer directly", async () => {
    const sandbox = buildGraph({
      extraFiles: {
        "node_modules/@solana/buffer-layout-utils/lib/cjs/decimal.js":
          'const bb = require("bigint-buffer");\nexports.decode = (src) => bb.toBigIntLE(src);\n',
      },
    });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/unreviewed .* module imports bigint-buffer/i);
  });

  it("refuses a module that reaches a bigint-buffer member outside the reviewed four", async () => {
    const source = `${COMPLIANT_LAYOUT}exports.raw = bigint_buffer_1.toBigIntUnchecked;\n`;
    await expect(verifyBigIntBufferException(buildGraph({ layoutSource: source })))
      .rejects.toThrow(/Unreviewed bigint-buffer member/);
  });

  it("refuses an import form neither module shape recognises", async () => {
    const source = [
      'const bb = require("bigint-buffer" + "");',
      "exports.decode = (src) => bb.toBigIntLE(src);",
      "exports.u64 = (0, exports.bigInt)(8);",
      "",
    ].join("\n");
    await expect(verifyBigIntBufferException(buildGraph({ layoutSource: source })))
      .rejects.toThrow(/unreviewed import form/i);
  });

  it("refuses a graph that no longer imports bigint-buffer", async () => {
    const source = [
      "exports.u64 = (0, exports.bigInt)(8);",
      "",
    ].join("\n");
    await expect(verifyBigIntBufferException(buildGraph({ layoutSource: source })))
      .rejects.toThrow(/no longer imports bigint-buffer/);
  });

  it("refuses a graph with no fixed-width layout left to review", async () => {
    const source = [
      'const bigint_buffer_1 = require("bigint-buffer");',
      "exports.decodeLE = (src) => bigint_buffer_1.toBigIntLE(Buffer.from(src));",
      "",
    ].join("\n");
    await expect(verifyBigIntBufferException(buildGraph({ layoutSource: source })))
      .rejects.toThrow(/No fixed-width bigint layout/);
  });

  it("refuses a loader that does not report the pure-JavaScript fallback", async () => {
    const sandbox = buildGraph({
      extraFiles: {
        "node_modules/bigint-buffer/dist/node.js": PURE_JS_BIGINT_BUFFER.replace(
          "catch (e) { console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)'); }",
          "catch (e) { /* silently keep going */ }",
        ),
      },
    });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/did not report its pure-JavaScript fallback/);
  });

  it("refuses a loader that drops one of the reviewed converters", async () => {
    const sandbox = buildGraph({
      extraFiles: {
        "node_modules/bigint-buffer/dist/node.js": PURE_JS_BIGINT_BUFFER.replace(
          "exports.toBufferLE = toBufferLE;",
          "",
        ),
      },
    });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/does not export toBufferLE/);
  });

  it("refuses a converter that does not round trip a 32 byte value", async () => {
    const sandbox = buildGraph({
      extraFiles: {
        "node_modules/bigint-buffer/dist/node.js": PURE_JS_BIGINT_BUFFER.replace(
          "exports.toBigIntLE = toBigIntLE;",
          "exports.toBigIntLE = (buf) => (buf.length === 32 ? BigInt(0) : toBigIntLE(buf));",
        ),
      },
    });
    await expect(verifyBigIntBufferException(sandbox)).rejects.toThrow(/did not round trip a 32 byte value/);
  });
});
