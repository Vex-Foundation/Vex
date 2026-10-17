/**
 * The version strings Settings shows, parsed from what the bundled binaries
 * and pgvector's control file actually print (outputs captured from the
 * native-runtime-2026.10.17-1 darwin-arm64 tree), and the release from the lock.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "" } }));
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { NATIVE_RUNTIME_RELEASE, parseExtensionVersion, parseLlamaVersion, parsePostgresVersion } = await import(
  "../native/runtime-versions.js"
);

describe("bundled runtime versions", () => {
  it("reads Postgres from `postgres --version`", () => {
    expect(parsePostgresVersion("postgres (PostgreSQL) 18.6\n")).toBe("18.6");
    expect(parsePostgresVersion("command not found")).toBeNull();
  });

  it("reads pgvector from vector.control's default_version", () => {
    const control = [
      "# vector extension",
      "comment = 'vector data type and ivfflat and hnsw access methods'",
      "default_version = '0.8.7'",
      "module_pathname = '$libdir/vector'",
      "relocatable = true",
    ].join("\n");
    expect(parseExtensionVersion(control)).toBe("0.8.7");
    expect(parseExtensionVersion("comment = 'no version here'")).toBeNull();
  });

  it("reads the llama.cpp build tag from `llama-server --version` (printed on stderr after the backend line)", () => {
    const output = [
      "load_backend: loaded CPU backend from /Applications/Vex.app/Contents/Resources/llama/libggml-cpu.so",
      "version: 9115 (78fbbc2)",
      "built with AppleClang 17.0.0.17000013 for Darwin arm64",
    ].join("\n");
    expect(parseLlamaVersion(output)).toBe("b9115");
    expect(parseLlamaVersion("load_backend: loaded CPU backend")).toBeNull();
  });

  it("names the release native-runtime.lock.json pins", () => {
    const lock = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../../../native-runtime.lock.json"), "utf8"),
    ) as { release: string };
    expect(NATIVE_RUNTIME_RELEASE).toBe(lock.release);
    expect(NATIVE_RUNTIME_RELEASE).toMatch(/^native-runtime-\d{4}\.\d{2}\.\d{2}-\d+$/);
  });
});
