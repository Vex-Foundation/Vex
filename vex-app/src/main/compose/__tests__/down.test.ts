/**
 * Tests for `composeDown`: the only way Vex stops a Docker install's
 * compose project now, used by the Docker-to-native migration. It must
 * stop (never remove) the project, and tell "not running" apart from a
 * Docker failure.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnRunnerResult } from "../../docker/spawn-runner.js";

const mocks = vi.hoisted(() => ({
  runSpawn: vi.fn(),
  inspectDockerEndpointPolicy: vi.fn(),
}));

vi.mock("../../docker/spawn-runner.js", () => ({ runSpawn: mocks.runSpawn }));
vi.mock("../../docker/endpoint-policy.js", () => ({
  inspectDockerEndpointPolicy: mocks.inspectDockerEndpointPolicy,
}));

import { composeDown } from "../down.js";

const INSTALL_ID = "11111111-2222-4333-8444-555555555555";

function spawnResult(partial: Partial<SpawnRunnerResult> = {}): SpawnRunnerResult {
  return { code: 0, signal: null, stdout: "", stderr: "", aborted: false, timedOut: false, ...partial };
}

let composeDir = "";
let composeOutPath = "";

beforeEach(async () => {
  vi.clearAllMocks();
  composeDir = await mkdtemp(path.join(tmpdir(), "vex-compose-down-"));
  composeOutPath = path.join(composeDir, "docker-compose.yml");
  await writeFile(composeOutPath, "services: {}\n");
  mocks.inspectDockerEndpointPolicy.mockResolvedValue({ accepted: true, message: null });
});

afterEach(async () => {
  await rm(composeDir, { recursive: true, force: true });
});

function commands(): string[][] {
  return mocks.runSpawn.mock.calls.map((call) => call[1] as string[]);
}

describe("composeDown", () => {
  it("refuses before running anything when the Docker endpoint is not accepted", async () => {
    mocks.inspectDockerEndpointPolicy.mockResolvedValue({ accepted: false, message: "DOCKER_HOST points elsewhere" });
    expect(await composeDown(composeOutPath, INSTALL_ID)).toEqual({
      kind: "failed",
      message: "DOCKER_HOST points elsewhere",
    });
    expect(mocks.runSpawn).not.toHaveBeenCalled();
  });

  it("stops the project from its compose dir and never removes volumes", async () => {
    mocks.runSpawn.mockResolvedValue(spawnResult());
    expect(await composeDown(composeOutPath, INSTALL_ID)).toMatchObject({ kind: "stopped" });
    expect(mocks.runSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.runSpawn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(command).toBe("docker");
    expect(args).toContain("stop");
    expect(args).toContain(`vex-${INSTALL_ID}`);
    expect(args).not.toContain("down");
    expect(args).not.toContain("--volumes");
    expect(options.cwd).toBe(composeDir);
  });

  it("reports a project compose does not know as not running", async () => {
    mocks.runSpawn.mockResolvedValue(spawnResult({ code: 1, stderr: "no such project" }));
    expect(await composeDown(composeOutPath, INSTALL_ID)).toMatchObject({ kind: "not_running" });
  });

  it("fails on any other compose stop error, without the label fallback", async () => {
    mocks.runSpawn.mockResolvedValue(spawnResult({ code: 1, stderr: "Cannot connect to the Docker daemon" }));
    expect(await composeDown(composeOutPath, INSTALL_ID)).toMatchObject({ kind: "failed" });
    expect(mocks.runSpawn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the project's labelled containers when the YAML is missing", async () => {
    mocks.runSpawn
      .mockResolvedValueOnce(spawnResult({ code: 1, stderr: "no configuration file provided" }))
      .mockResolvedValueOnce(spawnResult({ stdout: "aaa\nbbb\n" }))
      .mockResolvedValueOnce(spawnResult());
    expect(await composeDown(composeOutPath, INSTALL_ID)).toMatchObject({ kind: "stopped" });
    expect(commands()[1]).toContain("ps");
    expect(commands()[2]).toEqual(["stop", "aaa", "bbb"]);
  });

  it("goes straight to the label fallback when the compose dir is gone", async () => {
    await rm(composeDir, { recursive: true, force: true });
    mocks.runSpawn.mockResolvedValueOnce(spawnResult({ stdout: "" }));
    expect(await composeDown(composeOutPath, INSTALL_ID)).toMatchObject({ kind: "not_running" });
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toContain("ps");
  });

  it("treats a failed docker ps as a failure, not as nothing running", async () => {
    await rm(composeDir, { recursive: true, force: true });
    mocks.runSpawn.mockResolvedValueOnce(spawnResult({ code: 1, stderr: "permission denied" }));
    expect(await composeDown(composeOutPath, INSTALL_ID)).toMatchObject({ kind: "failed" });
  });

  it("fails when stopping the labelled containers fails", async () => {
    await rm(composeDir, { recursive: true, force: true });
    mocks.runSpawn
      .mockResolvedValueOnce(spawnResult({ stdout: "aaa\n" }))
      .mockResolvedValueOnce(spawnResult({ code: 1, stderr: "boom" }));
    expect(await composeDown(composeOutPath, INSTALL_ID)).toMatchObject({ kind: "failed" });
  });
});
