/**
 * The engine's CONFIG_DIR resolver, executed against the GOLDEN VECTORS.
 *
 * The same table `vex-app/src/main/paths/__tests__/config-dir.test.ts` and the
 * Go bridge's `internal/configdir` run. Three implementations, one fixture:
 * the Vex Studio endpoint discriminator is a SHA-256 over this directory, so a
 * drift between any two of them is a bridge that dials a path the app never
 * bound.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfigDir } from "../../config/paths.js";

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
  "..", "..", "..",
  "src", "vex-agent", "tools", "tool-surface-spec", "studio-mcp",
  "bridge-endpoint-vectors.json",
);

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

describe("resolveConfigDir golden vectors (engine owner)", () => {
  it("the fixture carries a resolver matrix at all", () => {
    expect(vectors.configDir.cases.length).toBeGreaterThan(15);
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
});

describe("the hardening: empty and relative directory variables are UNSET", () => {
  // The defect this closed: `process.env.XDG_CONFIG_HOME ?? join(homedir(),
  // ".config")` accepted an empty string, so `join("", "vex")` produced the
  // RELATIVE path "vex" and the config directory - keystores included - landed
  // in whatever working directory the launcher had. The XDG Base Directory
  // specification requires an empty value to be ignored.
  it("linux: an empty XDG_CONFIG_HOME never produces the relative path 'vex'", () => {
    const resolved = resolveConfigDir({
      platform: "linux",
      homedir: "/home/kuba",
      env: { XDG_CONFIG_HOME: "" },
    });
    expect(resolved).toBe("/home/kuba/.config/vex");
    expect(resolved).not.toBe("vex");
  });

  it("win32: an empty APPDATA falls back to the home directory", () => {
    expect(
      resolveConfigDir({
        platform: "win32",
        homedir: "C:\\Users\\kuba",
        env: { APPDATA: "" },
      }),
    ).toBe("C:\\Users\\kuba\\AppData\\Roaming\\vex");
  });

  it("a relative directory variable is ignored on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const home = platform === "win32" ? "C:\\Users\\kuba" : "/home/kuba";
      const target = platform === "win32" ? path.win32 : path.posix;
      const resolved = resolveConfigDir({
        platform,
        homedir: home,
        env: { VEX_CONFIG_DIR: "state", XDG_CONFIG_HOME: "conf", APPDATA: "roam" },
      });
      expect(target.isAbsolute(resolved)).toBe(true);
    }
  });
});

describe("parity with the vex-app owner", () => {
  it("both owners answer every vector identically", async () => {
    // Imported by path rather than by alias: this is deliberately a
    // cross-tree comparison, and naming the file is what makes the drift it
    // guards against visible in review. A failure to load is a FAILURE, not a
    // skip - the two owners are mirrored on purpose and the mirror is the
    // property under test.
    const appModule = (await import(
      path.resolve(__dirname, "..", "..", "..", "vex-app", "src", "main", "paths", "config-dir.ts")
    )) as { resolveConfigDir: typeof resolveConfigDir };
    const appResolve = appModule.resolveConfigDir;
    expect(typeof appResolve).toBe("function");
    for (const testCase of vectors.configDir.cases) {
      const deps = {
        platform: testCase.platform,
        homedir: testCase.homedir,
        env: testCase.env,
      };
      expect(appResolve(deps)).toBe(resolveConfigDir(deps));
    }
  });
});
