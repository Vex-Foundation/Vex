import { describe, expect, it, vi } from "vitest";

import { buildDockerPath, dockerSpawnEnv } from "../cli-env.js";

const DARWIN_CANDIDATES = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Users/test/.docker/bin",
  "/Users/test/.orbstack/bin",
  "/Users/test/.rd/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
];

const LINUX_CANDIDATES = [
  "/usr/local/bin",
  "/usr/bin",
  "/snap/bin",
  "/home/test/bin",
];

describe("buildDockerPath", () => {
  it.each([
    ["darwin", "/Users/test", DARWIN_CANDIDATES],
    ["linux", "/home/test", LINUX_CANDIDATES],
  ] as const)(
    "appends the %s candidate matrix after inherited PATH",
    (platform, homedir, candidates) => {
      const env = { PATH: "/system/bin:/custom/bin", KEEP: "yes" };

      const result = buildDockerPath({
        platform,
        homedir,
        env,
        dirExists: () => true,
      });

      expect(result).not.toBe(env);
      expect(result.KEEP).toBe("yes");
      expect(result.PATH?.split(":")).toEqual([
        "/system/bin",
        "/custom/bin",
        ...candidates,
      ]);
    },
  );

  it("appends only existing directories and deduplicates inherited entries", () => {
    const dirExists = vi.fn((candidate: string) => candidate !== "/snap/bin");

    const result = buildDockerPath({
      platform: "linux",
      homedir: "/home/test",
      env: { PATH: "/usr/bin:/custom/bin" },
      dirExists,
    });

    expect(result.PATH).toBe(
      "/usr/bin:/custom/bin:/usr/local/bin:/home/test/bin",
    );
    expect(dirExists).not.toHaveBeenCalledWith("/usr/bin");
  });

  it("resolves HOME-relative candidates from the injected homedir", () => {
    const result = buildDockerPath({
      platform: "darwin",
      homedir: "/custom/home",
      env: { PATH: "/bin" },
      dirExists: (candidate) => candidate.startsWith("/custom/home/"),
    });

    expect(result.PATH).toBe(
      "/bin:/custom/home/.docker/bin:/custom/home/.orbstack/bin:/custom/home/.rd/bin",
    );
  });

  // This test previously asserted `expect(result).toBe(env)` and that
  // `dirExists` was never called on Windows: the Windows branch returned
  // `process.env` by identity and did no augmentation at all. That
  // expectation encoded the reported bug, so it is replaced by the two
  // cases below, which assert augmentation happens AND that it never
  // creates a second key for the one case-insensitive Windows PATH.
  it("appends existing Windows Docker CLI directories to the inherited PATH", () => {
    const env = {
      Path: "C:\\Windows",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      KEEP: "yes",
    };
    const perUserBin =
      "C:\\Users\\test\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin";
    const dirExists = vi.fn((candidate: string) => candidate === perUserBin);

    const result = buildDockerPath({
      platform: "win32",
      homedir: "C:\\Users\\test",
      env,
      dirExists,
    });

    expect(result).not.toBe(env);
    expect(result.KEEP).toBe("yes");
    expect(result.Path).toBe(`C:\\Windows;${perUserBin}`);
    expect(dirExists).toHaveBeenCalledWith(perUserBin);
  });

  it("writes back to the existing Windows path key instead of adding a duplicate", () => {
    const env = {
      Path: "C:\\Windows",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    };

    const result = buildDockerPath({
      platform: "win32",
      homedir: "C:\\Users\\test",
      env,
      dirExists: () => true,
    });

    const pathKeys = Object.keys(result).filter(
      (key) => key.toLowerCase() === "path",
    );
    expect(pathKeys).toEqual(["Path"]);
    expect(result.PATH).toBeUndefined();
  });

  it("does not duplicate a Windows candidate already on PATH, case-insensitively", () => {
    const perUserBin =
      "C:\\Users\\test\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin";
    const result = buildDockerPath({
      platform: "win32",
      homedir: "C:\\Users\\test",
      env: {
        PATH: `C:\\Windows;${perUserBin.toUpperCase()}`,
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
      dirExists: (candidate) => candidate === perUserBin,
    });

    expect(result.PATH).toBe(`C:\\Windows;${perUserBin.toUpperCase()}`);
  });

  it("keeps working when Windows has no PATH and no install-root variables", () => {
    const result = buildDockerPath({
      platform: "win32",
      homedir: "C:\\Users\\test",
      env: { KEEP: "yes" },
      dirExists: () => true,
    });

    expect(result.KEEP).toBe("yes");
    expect(result.PATH).toBe("");
  });
});

describe("dockerSpawnEnv", () => {
  it("strips managed secrets from the real process.env (covers docker CLI + probe/daemon.ts callers)", () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      PATH: originalEnv.PATH ?? "/usr/bin",
      OPENROUTER_API_KEY: "secret",
      VEX_KEYSTORE_PASSWORD: "master-password",
    };
    try {
      const result = dockerSpawnEnv();

      expect(result.OPENROUTER_API_KEY).toBeUndefined();
      expect(result.VEX_KEYSTORE_PASSWORD).toBeUndefined();
      expect(result.PATH).toBeDefined();
    } finally {
      process.env = originalEnv;
    }
  });
});
