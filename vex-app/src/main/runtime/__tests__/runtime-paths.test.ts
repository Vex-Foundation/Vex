import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "" } }));

const { locatePostgresBinaries, pgDataDir, resolveRuntimeDir } = await import("../runtime-paths.js");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake tree with the four binaries, executable unless `mode` says otherwise. */
function tree(root: string, mode = 0o755): string {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["postgres", "initdb", "pg_ctl", "pg_controldata"]) {
    const file = path.join(bin, name);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, mode);
  }
  return root;
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-runtime-paths-"));
  roots.push(root);
  return root;
}

describe("RUNTIME_DIR", () => {
  it("is CONFIG_DIR/runtime on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(resolveRuntimeDir({ platform, homedir: "/home/u", env: {}, configDir: "/home/u/.config/vex" })).toBe(
        "/home/u/.config/vex/runtime",
      );
    }
  });

  it("is %LOCALAPPDATA%\\vex\\runtime on Windows, not the roaming CONFIG_DIR", () => {
    expect(
      resolveRuntimeDir({
        platform: "win32",
        homedir: "C:\\Users\\u",
        env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        configDir: "C:\\Users\\u\\AppData\\Roaming\\vex",
      }),
    ).toBe("C:\\Users\\u\\AppData\\Local\\vex\\runtime");
    expect(
      resolveRuntimeDir({ platform: "win32", homedir: "C:\\Users\\u", env: { LOCALAPPDATA: "rel" }, configDir: "x" }),
    ).toBe("C:\\Users\\u\\AppData\\Local\\vex\\runtime");
  });

  it("follows an explicit VEX_CONFIG_DIR on Windows too, so isolated installs never share a cluster", () => {
    expect(
      resolveRuntimeDir({
        platform: "win32",
        homedir: "C:\\Users\\u",
        env: { VEX_CONFIG_DIR: "D:\\iso\\vex", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        configDir: "D:\\iso\\vex",
      }),
    ).toBe("D:\\iso\\vex\\runtime");
  });

  it("puts the cluster in pg18", () => {
    expect(pgDataDir("/r")).toBe(path.join("/r", "pg18"));
  });
});

describe("locatePostgresBinaries", () => {
  it("packaged: <resources>/postgres/bin, and VEX_NATIVE_PG_DIR is ignored", async () => {
    const resources = tempRoot();
    tree(path.join(resources, "postgres"));
    const other = tree(path.join(tempRoot(), "elsewhere"));
    const found = await locatePostgresBinaries({
      packaged: true,
      resourcesPath: resources,
      env: { VEX_NATIVE_PG_DIR: other },
    });
    expect(found).toEqual({
      kind: "found",
      binaries: {
        postgres: path.join(resources, "postgres", "bin", "postgres"),
        initdb: path.join(resources, "postgres", "bin", "initdb"),
        pgCtl: path.join(resources, "postgres", "bin", "pg_ctl"),
        pgControldata: path.join(resources, "postgres", "bin", "pg_controldata"),
      },
    });
  });

  it("development: native-runtime/out/<platform>-<arch>/postgres under the repo", async () => {
    const repo = tempRoot();
    tree(path.join(repo, "native-runtime", "out", "linux-x64", "postgres"));
    const found = await locatePostgresBinaries({ packaged: false, repoRoot: repo, platform: "linux", arch: "x64", env: {} });
    expect(found.kind).toBe("found");
    if (found.kind === "found") {
      expect(found.binaries.postgres).toBe(path.join(repo, "native-runtime", "out", "linux-x64", "postgres", "bin", "postgres"));
    }
  });

  it("development: an absolute VEX_NATIVE_PG_DIR wins; a relative one is ignored", async () => {
    const repo = tempRoot();
    const override = tree(path.join(tempRoot(), "custom"));
    const found = await locatePostgresBinaries({
      packaged: false,
      repoRoot: repo,
      platform: "linux",
      arch: "x64",
      env: { VEX_NATIVE_PG_DIR: override },
    });
    expect(found.kind === "found" && found.binaries.initdb).toBe(path.join(override, "bin", "initdb"));
    const relative = await locatePostgresBinaries({
      packaged: false,
      repoRoot: repo,
      platform: "linux",
      arch: "x64",
      env: { VEX_NATIVE_PG_DIR: "custom" },
    });
    expect(relative.kind).toBe("unavailable");
  });

  it.skipIf(process.platform === "win32")("a binary that is not executable is unavailable", async () => {
    const resources = tempRoot();
    tree(path.join(resources, "postgres"), 0o644);
    const found = await locatePostgresBinaries({ packaged: true, resourcesPath: resources, env: {} });
    expect(found.kind).toBe("unavailable");
  });

  it("a missing tree is unavailable, with the build hint in development", async () => {
    const found = await locatePostgresBinaries({ packaged: false, repoRoot: tempRoot(), platform: "darwin", arch: "arm64", env: {} });
    expect(found).toMatchObject({ kind: "unavailable" });
    expect(found.kind === "unavailable" && found.detail).toMatch(/build\.sh/);
  });

  it("names .exe binaries on Windows", async () => {
    const found = await locatePostgresBinaries({ packaged: true, resourcesPath: tempRoot(), platform: "win32", env: {} });
    expect(found.kind === "unavailable" && found.detail).toMatch(/postgres\.exe/);
  });
});
