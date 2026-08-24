import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  dockerSpawnEnv: vi.fn(() => ({ PATH: "/augmented/docker/path" })),
  resolveDockerCli: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../cli-env.js", () => ({ dockerSpawnEnv: mocks.dockerSpawnEnv }));
vi.mock("../locate.js", () => ({ resolveDockerCli: mocks.resolveDockerCli }));

const DOCKER_EXE = "/opt/docker/bin/docker";

import { runSpawn } from "../spawn-runner.js";

function fakeChild(errorCode?: string): EventEmitter {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    pid: undefined,
    killed: false,
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    stdout.end();
    stderr.end();
    if (errorCode !== undefined) {
      child.emit(
        "error",
        Object.assign(new Error("spawn failed"), { code: errorCode }),
      );
    }
    child.emit("close", errorCode === undefined ? 0 : null, null);
  });
  return child;
}

describe("runSpawn environment and spawn errors", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.dockerSpawnEnv.mockClear();
    mocks.resolveDockerCli.mockReset().mockReturnValue({
      executablePath: DOCKER_EXE,
      source: "install_dir",
    });
    mocks.spawn.mockImplementation(() => fakeChild());
  });

  it("uses the augmented environment only for docker without caller env", async () => {
    await runSpawn("docker", ["info"]);

    expect(mocks.dockerSpawnEnv).toHaveBeenCalledOnce();
    // The bare name is resolved to the located absolute path so every
    // Docker caller in main spawns the same executable.
    expect(mocks.spawn).toHaveBeenCalledWith(
      DOCKER_EXE,
      ["info"],
      expect.objectContaining({ env: { PATH: "/augmented/docker/path" } }),
    );
  });

  it("falls back to the bare name when no Docker CLI can be located", async () => {
    mocks.resolveDockerCli.mockReturnValue(null);

    await runSpawn("docker", ["info"]);

    expect(mocks.spawn).toHaveBeenCalledWith(
      "docker",
      ["info"],
      expect.anything(),
    );
  });

  it("does not redirect a non-docker command through the locator", async () => {
    await runSpawn("systemctl", ["--user", "start", "docker-desktop"]);

    expect(mocks.resolveDockerCli).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", "docker-desktop"],
      expect.anything(),
    );
  });

  it("does not augment a non-docker command environment, but still strips managed secrets", async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, PATH: "/system/path", OPENROUTER_API_KEY: "secret" };
    try {
      await runSpawn("open", ["-a", "Docker"]);

      expect(mocks.dockerSpawnEnv).not.toHaveBeenCalled();
      const call = mocks.spawn.mock.calls[0];
      const passedEnv = (call?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
      expect(passedEnv).not.toBeUndefined();
      expect(passedEnv?.PATH).toBe("/system/path");
      expect(passedEnv?.OPENROUTER_API_KEY).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });

  it("strips managed secrets from a caller-supplied docker environment", async () => {
    const env = {
      PATH: "/caller/path",
      CUSTOM: "yes",
      OPENROUTER_API_KEY: "secret",
    };

    await runSpawn("docker", ["info"], { env });

    expect(mocks.dockerSpawnEnv).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      DOCKER_EXE,
      ["info"],
      expect.objectContaining({
        env: { PATH: "/caller/path", CUSTOM: "yes" },
      }),
    );
  });

  it("surfaces ENOENT from the child error event in stderr", async () => {
    mocks.spawn.mockImplementationOnce(() => fakeChild("ENOENT"));

    const result = await runSpawn("docker", ["info"]);

    expect(result.stderr).toContain("ENOENT");
  });
});
