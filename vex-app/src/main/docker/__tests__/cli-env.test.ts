import { describe, expect, it, vi } from "vitest";

import { MANAGED_SECRET_ENV_KEYS } from "@vex-lib/secret-keys.js";
import { buildDockerPath, withoutManagedSecrets } from "../cli-env.js";

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

  it("returns the Windows environment object untouched", () => {
    const env = { Path: "C:\\Windows", PATH: "C:\\Tools", KEEP: "yes" };
    const dirExists = vi.fn(() => true);

    const result = buildDockerPath({
      platform: "win32",
      homedir: "C:\\Users\\test",
      env,
      dirExists,
    });

    expect(result).toBe(env);
    expect(result).toEqual({
      Path: "C:\\Windows",
      PATH: "C:\\Tools",
      KEEP: "yes",
    });
    expect(dirExists).not.toHaveBeenCalled();
  });
});

describe("withoutManagedSecrets", () => {
  it("removes every managed secret key and keeps operational docker vars", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      HOME: "/Users/test",
      OPENROUTER_API_KEY: "sk-leak",
      TAVILY_API_KEY: "tvly-leak",
      JUPITER_API_KEY: "jup-leak",
      POLYMARKET_API_KEY: "poly-key",
      POLYMARKET_API_SECRET: "poly-secret",
      POLYMARKET_PASSPHRASE: "poly-pass",
      POLYMARKET_CLOB_CREDENTIALS_BY_ADDRESS: '{"0xabc":{"key":"x"}}',
      RETTIWT_API_KEY: "rettiwt-leak",
      VEX_KEYSTORE_PASSWORD: "master-leak",
      KEEP: "yes",
    };

    const result = withoutManagedSecrets(env);

    for (const key of MANAGED_SECRET_ENV_KEYS) {
      expect(result[key], `${key} must be stripped`).toBeUndefined();
    }
    expect(result.PATH).toBe("/usr/bin");
    expect(result.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(result.HOME).toBe("/Users/test");
    expect(result.KEEP).toBe("yes");
  });

  it("does not mutate the input object (win32 identity-return safety)", () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "sk-still-in-parent",
      PATH: "/bin",
    };
    const result = withoutManagedSecrets(env);

    expect(result).not.toBe(env);
    expect(env.OPENROUTER_API_KEY).toBe("sk-still-in-parent");
    expect(result.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("strips secrets after PATH augmentation (unlocked → docker spawn shape)", () => {
    const unlocked: NodeJS.ProcessEnv = {
      PATH: "/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      OPENROUTER_API_KEY: "sk-or-v1-REPRO-LEAK-TOKEN",
      TAVILY_API_KEY: "tvly-REPRO-LEAK",
      POLYMARKET_API_SECRET: "poly-secret-REPRO",
      VEX_KEYSTORE_PASSWORD: "master-leak",
    };

    const withPath = buildDockerPath({
      platform: "linux",
      homedir: "/home/test",
      env: unlocked,
      dirExists: () => false,
    });
    const spawnEnv = withoutManagedSecrets(withPath);

    expect(spawnEnv.PATH).toBe("/bin");
    expect(spawnEnv.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    for (const key of MANAGED_SECRET_ENV_KEYS) {
      expect(spawnEnv[key], `${key} must not reach docker child`).toBeUndefined();
    }
    // Main-process analog (unlocked env) still holds secrets for the engine.
    expect(unlocked.OPENROUTER_API_KEY).toBe("sk-or-v1-REPRO-LEAK-TOKEN");
  });
});
