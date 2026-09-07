/**
 * The uuid reachability verifier, driven against SYNTHETIC installed graphs.
 *
 * The exception for uuid 8.3.2 (GHSA-w5hq-g745-h8pq) is not "the advisory does
 * not apply to us" as an opinion; it is a claim about the installed Jayson
 * sources: v4 only, and never with a caller-provided buffer. This suite builds
 * throwaway node_modules trees that each break exactly one half of that claim
 * and asserts the verifier refuses, so weakening the verifier to "it imports
 * uuid somewhere" turns these red.
 *
 * The real installed graph is exercised by `pnpm run audit:deps`, which calls
 * the same function with the workspace root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

// @ts-expect-error - the gate scripts are plain ESM with no type declarations.
import { verifyUuidException } from "../../../scripts/verify-uuid-exception.mjs";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

/** A minimal installed graph: project -> @solana/web3.js -> jayson -> uuid. */
function buildGraph(utilsSource: string): string {
  const sandbox = mkdtempSync(path.join(tmpdir(), "vex-uuid-exception-"));
  sandboxes.push(sandbox);
  const write = (relative: string, contents: string): void => {
    const absolute = path.join(sandbox, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  };
  write("package.json", JSON.stringify({ name: "sandbox", version: "0.0.0" }));
  write("node_modules/@solana/web3.js/package.json", JSON.stringify({ name: "@solana/web3.js", version: "1.98.4", main: "index.js" }));
  write("node_modules/@solana/web3.js/index.js", "module.exports = {};\n");
  write("node_modules/jayson/package.json", JSON.stringify({ name: "jayson", version: "4.3.0", main: "index.js" }));
  write("node_modules/jayson/index.js", "module.exports = require('./lib/utils');\n");
  write("node_modules/jayson/lib/utils.js", utilsSource);
  write("node_modules/uuid/package.json", JSON.stringify({ name: "uuid", version: "8.3.2", main: "index.js" }));
  write(
    "node_modules/uuid/index.js",
    [
      "let counter = 0;",
      "function hex(length) { return Array.from({ length }, () => (counter++ % 16).toString(16)).join(''); }",
      "exports.v4 = function v4() { counter += 1; return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`; };",
      "exports.v5 = function v5() { return exports.v4(); };",
      "",
    ].join("\n"),
  );
  return sandbox;
}

const COMPLIANT = [
  "const uuid = require('uuid').v4;",
  "exports.generateId = function () { return uuid(); };",
  "",
].join("\n");

describe("verify-uuid-exception", () => {
  it("accepts a graph that binds uuid v4 and calls it with no arguments", async () => {
    await expect(verifyUuidException(buildGraph(COMPLIANT))).resolves.toBeUndefined();
  });

  it("refuses a graph that reaches a generator other than v4", async () => {
    const source = [
      "const uuid = require('uuid').v4;",
      "const legacy = require('uuid').v5;",
      "exports.generateId = function () { return uuid(); };",
      "exports.legacyId = function () { return legacy(); };",
      "",
    ].join("\n");
    await expect(verifyUuidException(buildGraph(source))).rejects.toThrow(/Unreviewed uuid import/);
  });

  it("refuses a namespace import that could reach any generator", async () => {
    const source = [
      "const uuid = require('uuid');",
      "exports.generateId = function () { return uuid.v4(); };",
      "",
    ].join("\n");
    await expect(verifyUuidException(buildGraph(source))).rejects.toThrow(/Unreviewed uuid import/);
  });

  it("refuses a call site that passes a caller-provided buffer", async () => {
    const source = [
      "const uuid = require('uuid').v4;",
      "const scratch = Buffer.alloc(16);",
      "exports.generateId = function () { return uuid(undefined, scratch); };",
      "",
    ].join("\n");
    await expect(verifyUuidException(buildGraph(source))).rejects.toThrow(/passes arguments to uuid/);
  });

  it("refuses a graph that imports uuid but never calls it", async () => {
    const source = [
      "const uuid = require('uuid').v4;",
      "exports.generateId = function () { return 'static'; };",
      "exports.unused = uuid;",
      "",
    ].join("\n");
    await expect(verifyUuidException(buildGraph(source))).rejects.toThrow(/imported but never called/);
  });

  it("refuses a reachable entry point that does not produce a v4 identifier", async () => {
    const source = [
      "const uuid = require('uuid').v4;",
      "exports.generateId = function () { uuid(); return 'not-a-uuid'; };",
      "",
    ].join("\n");
    await expect(verifyUuidException(buildGraph(source))).rejects.toThrow(/did not produce a v4 identifier/);
  });

  it("refuses an entry point that returns a constant identifier", async () => {
    const source = [
      "const uuid = require('uuid').v4;",
      "const frozen = uuid();",
      "exports.generateId = function () { return frozen; };",
      "",
    ].join("\n");
    await expect(verifyUuidException(buildGraph(source))).rejects.toThrow(/constant identifier/);
  });
});
