/**
 * The CONFIG_DIR resolver, executed against the GOLDEN VECTORS.
 *
 * This is not a mirror-check between two TypeScript files any more. The Vex
 * Studio endpoint discriminator is a SHA-256 over this directory, and three
 * independent implementations derive it: this one, `src/config/paths.ts`, and
 * the standalone Go bridge (`bridge/internal/configdir`). A drift of one
 * separator between any two of them is a bridge that dials a path the app
 * never bound, so all three run the same table from
 * `studio-mcp/bridge-endpoint-vectors.json`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  ELECTRON_STATE_DIR,
  ENV_FILE,
  INSTALL_ID_FILE,
  PG_PASSWORD_FILE,
  SECRETS_DIR,
  SETUP_COMPLETE_FILE,
  resolveConfigDir,
} from "../config-dir.js";

interface ConfigDirCase {
  readonly name: string;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: Record<string, string>;
  readonly expect: string;
}

interface Vectors {
  readonly configDir: {
    readonly appName: string;
    readonly cases: readonly ConfigDirCase[];
  };
}

const VECTORS_PATH = path.resolve(
  __dirname,
  "..", "..", "..", "..", "..",
  "src", "vex-agent", "tools", "tool-surface-spec", "studio-mcp",
  "bridge-endpoint-vectors.json",
);

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

describe("resolveConfigDir golden vectors", () => {
  it("the fixture carries a resolver matrix at all", () => {
    expect(vectors.configDir.cases.length).toBeGreaterThan(15);
    expect(vectors.configDir.appName).toBe("vex");
  });

  it.each(vectors.configDir.cases)("$name", (testCase) => {
    expect(
      resolveConfigDir({
        platform: testCase.platform,
        homedir: testCase.homedir,
        env: testCase.env,
      }),
    ).toBe(testCase.expect);
  });

  it("every documented environment name appears in the matrix", () => {
    const covered = new Set<string>();
    for (const testCase of vectors.configDir.cases) {
      for (const name of Object.keys(testCase.env)) covered.add(name);
    }
    expect([...covered].sort()).toEqual(["APPDATA", "VEX_CONFIG_DIR", "XDG_CONFIG_HOME"]);
  });
});

describe("the hardening: empty and relative directory variables are UNSET", () => {
  // The defect this closed: `env["XDG_CONFIG_HOME"] ?? join(home, ".config")`
  // accepted an empty string, so `join("", "vex")` produced the RELATIVE path
  // "vex" and the config directory landed in whatever cwd the launcher had.
  // The XDG Base Directory specification requires an empty value to be ignored.
  it.each([
    ["XDG_CONFIG_HOME", ""],
    ["XDG_CONFIG_HOME", "relative/config"],
    ["XDG_CONFIG_HOME", "."],
  ])("linux %s=%j falls back to the home directory", (name, value) => {
    const resolved = resolveConfigDir({
      platform: "linux",
      homedir: "/home/kuba",
      env: { [name]: value },
    });
    expect(resolved).toBe("/home/kuba/.config/vex");
    expect(path.posix.isAbsolute(resolved)).toBe(true);
  });

  it.each([
    ["APPDATA", ""],
    ["APPDATA", "AppData\\Roaming"],
  ])("win32 %s=%j falls back to the home directory", (name, value) => {
    expect(
      resolveConfigDir({
        platform: "win32",
        homedir: "C:\\Users\\kuba",
        env: { [name]: value },
      }),
    ).toBe("C:\\Users\\kuba\\AppData\\Roaming\\vex");
  });

  it("never returns a relative path for any empty-variable combination", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const home = platform === "win32" ? "C:\\Users\\kuba" : "/home/kuba";
      const resolved = resolveConfigDir({
        platform,
        homedir: home,
        env: { VEX_CONFIG_DIR: "", XDG_CONFIG_HOME: "", APPDATA: "" },
      });
      const target = platform === "win32" ? path.win32 : path.posix;
      expect(target.isAbsolute(resolved)).toBe(true);
      expect(resolved).not.toBe("vex");
    }
  });
});

describe("the override contract", () => {
  it("honours an absolute VEX_CONFIG_DIR (test/CI escape hatch)", () => {
    expect(
      resolveConfigDir({
        platform: "linux",
        homedir: "/home/kuba",
        env: { VEX_CONFIG_DIR: "/tmp/vex-e2e-abc123" },
      }),
    ).toBe("/tmp/vex-e2e-abc123");
  });

  it("returns an accepted override VERBATIM, trailing separator included", () => {
    // A trailing separator is a different string, therefore a different hash,
    // therefore a different endpoint. Tidying it on one side of the wire only
    // is the exact drift the contract forbids.
    for (const value of ["/srv/vexstate", "/srv/vexstate/", "/srv//vexstate/./"]) {
      expect(
        resolveConfigDir({ platform: "linux", homedir: "/home/kuba", env: { VEX_CONFIG_DIR: value } }),
      ).toBe(value);
    }
  });

  it("uses the same lowercase `vex` app name as the engine resolver", () => {
    // src/config/paths.ts declares APP_NAME = "vex". A capitalised variant here
    // would silently split user state across two directories.
    const dir = resolveConfigDir({ platform: "linux", homedir: "/home/x", env: {} });
    expect(dir.endsWith("/vex")).toBe(true);
    expect(dir.endsWith("/Vex")).toBe(false);
  });
});

describe("derived path constants", () => {
  it("places the Electron-private state nested under CONFIG_DIR", () => {
    expect(ELECTRON_STATE_DIR.endsWith(path.join("vex", ".electron-state"))).toBe(true);
  });

  it("places shared resources at CONFIG_DIR root, not under .electron-state", () => {
    expect(ENV_FILE.includes(".electron-state")).toBe(false);
    expect(INSTALL_ID_FILE.includes(".electron-state")).toBe(false);
    expect(SETUP_COMPLETE_FILE.includes(".electron-state")).toBe(false);
    expect(SECRETS_DIR.includes(".electron-state")).toBe(false);
    expect(PG_PASSWORD_FILE.includes(".electron-state")).toBe(false);
  });

  it("PG password lives at CONFIG_DIR/local-infra/secrets/pg_password", () => {
    expect(PG_PASSWORD_FILE.endsWith(path.join("local-infra", "secrets", "pg_password"))).toBe(true);
  });
});
