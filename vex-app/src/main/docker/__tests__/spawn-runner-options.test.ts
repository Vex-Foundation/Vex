import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  dockerSpawnEnv: vi.fn(() => ({ PATH: "/augmented/docker/path" })),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
// Keep real withoutManagedSecrets so strip behavior is exercised; only stub
// dockerSpawnEnv (PATH augmentation is orthogonal to secret scrubbing).
vi.mock("../cli-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-env.js")>();
  return {
    ...actual,
    dockerSpawnEnv: mocks.dockerSpawnEnv,
  };
});

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

function lastSpawnEnv(): NodeJS.ProcessEnv | undefined {
  const opts = mocks.spawn.mock.calls.at(-1)?.[2] as
    | { env?: NodeJS.ProcessEnv }
    | undefined;
  return opts?.env;
}

describe("runSpawn environment and spawn errors", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.dockerSpawnEnv.mockClear();
    mocks.spawn.mockImplementation(() => fakeChild());
  });

  it("uses the augmented environment only for docker without caller env", async () => {
    await runSpawn("docker", ["info"]);

    expect(mocks.dockerSpawnEnv).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith(
      "docker",
      ["info"],
      expect.objectContaining({ env: { PATH: "/augmented/docker/path" } }),
    );
  });

  it("strips managed secrets from non-docker commands (no parent env inherit)", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-parent-leak";
    process.env.TAVILY_API_KEY = "tvly-parent-leak";
    try {
      await runSpawn("open", ["-a", "Docker"]);

      expect(mocks.dockerSpawnEnv).not.toHaveBeenCalled();
      const env = lastSpawnEnv();
      expect(env).toBeDefined();
      expect(env?.OPENROUTER_API_KEY).toBeUndefined();
      expect(env?.TAVILY_API_KEY).toBeUndefined();
      // Parent process must still hold secrets for the agent.
      expect(process.env.OPENROUTER_API_KEY).toBe("sk-parent-leak");
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("strips managed secrets from caller-supplied env without mutating it", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/caller/path",
      CUSTOM: "yes",
      OPENROUTER_API_KEY: "sk-caller-leak",
      POLYMARKET_API_SECRET: "poly-leak",
    };

    await runSpawn("docker", ["info"], { env });

    expect(mocks.dockerSpawnEnv).not.toHaveBeenCalled();
    const spawned = lastSpawnEnv();
    expect(spawned?.PATH).toBe("/caller/path");
    expect(spawned?.CUSTOM).toBe("yes");
    expect(spawned?.OPENROUTER_API_KEY).toBeUndefined();
    expect(spawned?.POLYMARKET_API_SECRET).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBe("sk-caller-leak");
  });

  it("surfaces ENOENT from the child error event in stderr", async () => {
    mocks.spawn.mockImplementationOnce(() => fakeChild("ENOENT"));

    const result = await runSpawn("docker", ["info"]);

    expect(result.stderr).toContain("ENOENT");
  });
});
