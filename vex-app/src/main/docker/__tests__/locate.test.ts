/**
 * Locator contract: install directories are probed on the FILESYSTEM before
 * PATH is consulted, and Windows environment hazards (case-insensitive
 * PATH/Path, PATHEXT, quoted entries with spaces, missing variables, a
 * candidate that is a directory) are handled.
 *
 * Every case injects `env`, `platform`, `homedir` and `fileExists`, so
 * Windows resolution is exercised from any host OS and nothing here touches
 * the real environment or the real filesystem.
 */

import { describe, expect, it, vi } from "vitest";

import {
  dockerCliDirectories,
  dockerDesktopInstallRoots,
  findExecutableOnPath,
  getEnvCaseInsensitive,
  locateDockerCli,
  locateDockerDesktopExe,
  resolveEnvKey,
  type LocatorContext,
} from "../locate.js";

const LOCAL_APP_DATA = "C:\\Users\\test\\AppData\\Local";
const PER_USER_BIN = `${LOCAL_APP_DATA}\\Programs\\DockerDesktop\\resources\\bin`;
const PER_USER_EXE = `${PER_USER_BIN}\\docker.exe`;
const ALL_USERS_EXE =
  "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";

function winContext(
  env: NodeJS.ProcessEnv,
  existing: ReadonlyArray<string>,
): LocatorContext {
  const present = new Set(existing.map((entry) => entry.toLowerCase()));
  return {
    platform: "win32",
    homedir: "C:\\Users\\test",
    env,
    fileExists: (candidate) => present.has(candidate.toLowerCase()),
  };
}

describe("getEnvCaseInsensitive / resolveEnvKey", () => {
  it("reads a Windows variable through either spelling", () => {
    expect(getEnvCaseInsensitive({ Path: "C:\\Windows" }, "PATH")).toBe(
      "C:\\Windows",
    );
    expect(getEnvCaseInsensitive({ PATH: "C:\\Windows" }, "Path")).toBe(
      "C:\\Windows",
    );
    expect(getEnvCaseInsensitive({}, "PATH")).toBeUndefined();
  });

  it("resolves the key spelling that already exists so no duplicate is created", () => {
    expect(resolveEnvKey({ Path: "x" }, "PATH")).toBe("Path");
    expect(resolveEnvKey({ PATH: "x" }, "PATH")).toBe("PATH");
    expect(resolveEnvKey({ OTHER: "x" }, "PATH")).toBeNull();
  });
});

describe("dockerDesktopInstallRoots", () => {
  it("puts the per-user default first, then ProgramW6432, ProgramFiles, ProgramFiles(x86)", () => {
    expect(
      dockerDesktopInstallRoots({
        LOCALAPPDATA: LOCAL_APP_DATA,
        ProgramW6432: "C:\\Program Files",
        ProgramFiles: "C:\\Program Files (x86)",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      }),
    ).toEqual([
      `${LOCAL_APP_DATA}\\Programs\\DockerDesktop`,
      "C:\\Program Files\\Docker\\Docker",
      "C:\\Program Files (x86)\\Docker\\Docker",
    ]);
  });

  it("skips missing and blank environment variables instead of joining undefined", () => {
    expect(
      dockerDesktopInstallRoots({ LOCALAPPDATA: "", ProgramFiles: undefined }),
    ).toEqual([]);
  });

  it("reads install roots through a lowercase Windows spelling", () => {
    expect(dockerDesktopInstallRoots({ localappdata: LOCAL_APP_DATA })).toEqual([
      `${LOCAL_APP_DATA}\\Programs\\DockerDesktop`,
    ]);
  });
});

describe("dockerCliDirectories", () => {
  it("derives the Windows CLI dirs from the install roots", () => {
    expect(
      dockerCliDirectories({
        platform: "win32",
        homedir: "C:\\Users\\test",
        env: { LOCALAPPDATA: LOCAL_APP_DATA },
      }),
    ).toEqual([PER_USER_BIN]);
  });

  it("keeps the existing darwin candidate matrix", () => {
    expect(
      dockerCliDirectories({
        platform: "darwin",
        homedir: "/Users/test",
        env: {},
      }),
    ).toEqual([
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/Users/test/.docker/bin",
      "/Users/test/.orbstack/bin",
      "/Users/test/.rd/bin",
      "/Applications/Docker.app/Contents/Resources/bin",
    ]);
  });
});

describe("findExecutableOnPath", () => {
  it("expands PATHEXT on Windows, honouring the documented default", () => {
    // Windows filenames are case-insensitive, so the returned path carries
    // whatever casing PATHEXT used; `winContext` matches accordingly.
    const ctx = winContext({ Path: "C:\\Tools" }, ["C:\\Tools\\docker.exe"]);
    expect(findExecutableOnPath("docker", ctx)?.toLowerCase()).toBe(
      "c:\\tools\\docker.exe",
    );

    // A .cmd shim is found too, because the default PATHEXT lists it.
    const cmdShim = winContext({ Path: "C:\\Tools" }, ["C:\\Tools\\docker.cmd"]);
    expect(findExecutableOnPath("docker", cmdShim)?.toLowerCase()).toBe(
      "c:\\tools\\docker.cmd",
    );
  });

  it("uses an explicit PATHEXT when the environment supplies one", () => {
    const ctx = winContext(
      { Path: "C:\\Tools", PATHEXT: ".bat" },
      ["C:\\Tools\\docker.exe", "C:\\Tools\\docker.bat"],
    );
    expect(findExecutableOnPath("docker", ctx)).toBe("C:\\Tools\\docker.bat");
  });

  it("handles quoted PATH entries containing spaces", () => {
    const ctx = winContext(
      {
        Path: '"C:\\Program Files\\Docker\\Docker\\resources\\bin";C:\\Windows',
        PATHEXT: ".exe",
      },
      ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"],
    );
    expect(findExecutableOnPath("docker", ctx)).toBe(ALL_USERS_EXE);
  });

  it("ignores relative PATH entries, which would resolve against the cwd", () => {
    const ctx = winContext({ Path: ".;..\\bin" }, [".\\docker.exe"]);
    expect(findExecutableOnPath("docker", ctx)).toBeNull();
  });

  it("returns null when PATH is absent or empty", () => {
    expect(findExecutableOnPath("docker", winContext({}, []))).toBeNull();
    expect(
      findExecutableOnPath("docker", winContext({ Path: "   " }, [])),
    ).toBeNull();
  });

  it("finds a posix executable without extension expansion", () => {
    expect(
      findExecutableOnPath("docker", {
        platform: "linux",
        homedir: "/home/test",
        env: { PATH: "/opt/x/bin:/usr/bin" },
        fileExists: (candidate) => candidate === "/usr/bin/docker",
      }),
    ).toBe("/usr/bin/docker");
  });
});

describe("locateDockerCli", () => {
  /**
   * THE REPORTED BUG, as a regression test. A Windows user installs Docker
   * Desktop while Vex is already running: `process.env` is a launch-time
   * snapshot so PATH still has no Docker, yet `docker.exe` is on disk at
   * the default per-user install location. Detection must report installed.
   * Reverting to a PATH-only detector turns this red.
   */
  it("finds a Docker installed after launch, when the PATH snapshot predates it", () => {
    const ctx = winContext(
      { Path: "C:\\Windows;C:\\Windows\\System32", LOCALAPPDATA: LOCAL_APP_DATA },
      [PER_USER_EXE],
    );

    expect(locateDockerCli(ctx)).toEqual({
      executablePath: PER_USER_EXE,
      source: "install_dir",
    });
  });

  it("prefers the per-user install over the all-users install", () => {
    const ctx = winContext(
      {
        Path: "C:\\Windows",
        LOCALAPPDATA: LOCAL_APP_DATA,
        ProgramFiles: "C:\\Program Files",
      },
      [PER_USER_EXE, ALL_USERS_EXE],
    );

    expect(locateDockerCli(ctx)?.executablePath).toBe(PER_USER_EXE);
  });

  it("probes install directories before PATH", () => {
    const fileExists = vi.fn(
      (candidate: string) =>
        candidate === PER_USER_EXE || candidate === "C:\\Tools\\docker.exe",
    );
    const result = locateDockerCli({
      platform: "win32",
      homedir: "C:\\Users\\test",
      env: { Path: "C:\\Tools", LOCALAPPDATA: LOCAL_APP_DATA },
      fileExists,
    });

    expect(result?.executablePath).toBe(PER_USER_EXE);
    expect(fileExists).not.toHaveBeenCalledWith("C:\\Tools\\docker.exe");
  });

  it("falls back to PATH for a custom --installation-dir install", () => {
    const ctx = winContext(
      {
        Path: "D:\\Custom\\Docker\\resources\\bin",
        PATHEXT: ".exe",
        LOCALAPPDATA: LOCAL_APP_DATA,
      },
      ["D:\\Custom\\Docker\\resources\\bin\\docker.exe"],
    );

    expect(locateDockerCli(ctx)).toEqual({
      executablePath: "D:\\Custom\\Docker\\resources\\bin\\docker.exe",
      source: "path",
    });
  });

  it("does not accept a candidate that is a directory", () => {
    const ctx: LocatorContext = {
      platform: "win32",
      homedir: "C:\\Users\\test",
      env: { Path: "C:\\Windows", LOCALAPPDATA: LOCAL_APP_DATA },
      // `fileExists` is contractually "exists AND is not a directory", so a
      // directory named docker.exe reports false and must not be located.
      fileExists: () => false,
    };

    expect(locateDockerCli(ctx)).toBeNull();
  });

  it("returns null when nothing is installed and PATH has no Docker", () => {
    expect(
      locateDockerCli(
        winContext({ Path: "C:\\Windows", LOCALAPPDATA: LOCAL_APP_DATA }, []),
      ),
    ).toBeNull();
  });

  it("locates the darwin CLI through the shared candidate matrix", () => {
    expect(
      locateDockerCli({
        platform: "darwin",
        homedir: "/Users/test",
        env: { PATH: "/usr/bin" },
        fileExists: (candidate) =>
          candidate ===
          "/Applications/Docker.app/Contents/Resources/bin/docker",
      }),
    ).toEqual({
      executablePath:
        "/Applications/Docker.app/Contents/Resources/bin/docker",
      source: "install_dir",
    });
  });
});

describe("locateDockerDesktopExe", () => {
  it("resolves the GUI executable from the same install roots as the CLI", () => {
    expect(
      locateDockerDesktopExe({
        env: { LOCALAPPDATA: LOCAL_APP_DATA, ProgramFiles: "C:\\Program Files" },
        fileExists: (candidate) =>
          candidate === "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
      }),
    ).toBe("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe");
  });

  it("returns null when Docker Desktop is not in any known root", () => {
    expect(
      locateDockerDesktopExe({
        env: { LOCALAPPDATA: LOCAL_APP_DATA },
        fileExists: () => false,
      }),
    ).toBeNull();
  });
});
