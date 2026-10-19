/**
 * The Docker source of the migration, over mocked compose code: what it runs,
 * and above all what it refuses to run. The real commands are exercised by
 * docker-to-native.real.test.ts.
 */

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSpawn: vi.fn(),
  checkDockerDaemon: vi.fn(),
  composeDown: vi.fn(),
  waitForHealth: vi.fn(),
  checkComposeFloor: vi.fn(),
  ensureDockerDaemonReady: vi.fn(),
  inspectDockerEndpointPolicy: vi.fn(),
  recreateProjectNonDestructively: vi.fn(),
  renderCompose: vi.fn(),
  composeUpDetached: vi.fn(),
  access: vi.fn(),
  chooseFreePort: vi.fn(),
}));

vi.mock("../../docker/spawn-runner.js", () => ({ runSpawn: mocks.runSpawn }));
vi.mock("../../docker/daemon.js", () => ({ checkDockerDaemon: mocks.checkDockerDaemon }));
vi.mock("../../compose/down.js", () => ({ composeDown: mocks.composeDown }));
vi.mock("../../compose/health.js", () => ({ waitForHealth: mocks.waitForHealth }));
vi.mock("../../compose/preflight.js", () => ({
  checkComposeFloor: mocks.checkComposeFloor,
  ensureDockerDaemonReady: mocks.ensureDockerDaemonReady,
  inspectDockerEndpointPolicy: mocks.inspectDockerEndpointPolicy,
}));
vi.mock("../../compose/recreate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../compose/recreate.js")>()),
  recreateProjectNonDestructively: mocks.recreateProjectNonDestructively,
}));
vi.mock("../../compose/up.js", () => ({ composeUpDetached: mocks.composeUpDetached }));
vi.mock("../../compose/render.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../compose/render.js")>()),
  renderCompose: mocks.renderCompose,
}));
vi.mock("../native/free-port.js", () => ({ chooseFreePort: mocks.chooseFreePort }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, promises: { ...real.promises, access: mocks.access } };
});

const { createDockerSource } = await import("../migration/docker-source.js");
const { resolvePgPort } = await import("../../paths/service-ports.js");

const ID = "0f5b8f8e-1111-2222-3333-444444444444";
const CONFIG = path.join(path.sep, "cfg");
const COMPOSE_DIR = path.join(CONFIG, "compose");
const PASSWORD = path.join(CONFIG, "local-infra", "secrets", "pg_password");

const ok = (stdout = "", stderr = "") => ({ code: 0, signal: null, stdout, stderr, aborted: false, timedOut: false });
const exit = (code: number, stderr: string) => ({ code, signal: null, stdout: "", stderr, aborted: false, timedOut: false });

/** A source publishing on `pgPort`; null leaves the port to the source. */
function source(pgPort: number | null = 27999) {
  return createDockerSource({
    renderDeps: {
      userDataDir: CONFIG,
      resourcesDir: "/res",
      secretAdapter: { write: vi.fn(), read: vi.fn(), cleanup: vi.fn(), bootCleanup: vi.fn() },
      randomAdapter: { uuid: () => "x", randomBytes: () => new Uint8Array() },
      cryptoAdapter: { base64url: () => "" },
    },
    ...(pgPort !== null ? { pgPort } : {}),
  });
}

/** `docker volume inspect` answers. */
function volume(answer: "present" | "absent" | "error"): void {
  mocks.runSpawn.mockImplementation(async (_cmd: string, args: readonly string[]) => {
    if (args[0] === "volume") {
      if (answer === "present") return ok(`vex-postgres-data-${ID}\n`);
      if (answer === "absent") return exit(1, `Error response from daemon: get vex-postgres-data-${ID}: no such volume`);
      return exit(1, "Cannot connect to the Docker daemon");
    }
    return ok();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectDockerEndpointPolicy.mockResolvedValue({ accepted: true, message: null });
  mocks.checkDockerDaemon.mockResolvedValue({ ok: true, reason: "Server 29" });
  mocks.checkComposeFloor.mockResolvedValue(null);
  mocks.ensureDockerDaemonReady.mockResolvedValue({ kind: "ready", message: "ok" });
  mocks.renderCompose.mockResolvedValue({
    outPath: path.join(COMPOSE_DIR, "docker-compose.yml"),
    installId: ID,
    pgPasswordComposePath: PASSWORD,
    embedPort: 27134,
  });
  mocks.composeUpDetached.mockResolvedValue(ok());
  mocks.waitForHealth.mockResolvedValue({ verdict: "usable", message: "ours" });
  mocks.composeDown.mockResolvedValue({ kind: "stopped", message: "stopped" });
  mocks.access.mockResolvedValue(undefined);
  volume("present");
});

describe("probe", () => {
  it("answers from `docker volume inspect` and never starts Docker", async () => {
    expect(await source().probe(ID)).toEqual({ kind: "volume_present" });
    volume("absent");
    expect(await source().probe(ID)).toEqual({ kind: "volume_absent" });
    volume("error");
    expect(await source().probe(ID)).toMatchObject({ kind: "unreachable" });
    expect(mocks.ensureDockerDaemonReady).not.toHaveBeenCalled();
    expect(mocks.runSpawn).toHaveBeenCalledWith(
      "docker",
      ["volume", "inspect", "--format", "{{.Name}}", `vex-postgres-data-${ID}`],
      expect.anything(),
    );
  });

  it("a stopped daemon or a remote endpoint is unreachable, without inspecting anything", async () => {
    mocks.checkDockerDaemon.mockResolvedValueOnce({ ok: false, reason: "docker info timed out" });
    expect(await source().probe(ID)).toEqual({ kind: "unreachable", detail: "docker info timed out" });
    mocks.inspectDockerEndpointPolicy.mockResolvedValueOnce({ accepted: false, message: "remote context" });
    expect(await source().probe(ID)).toEqual({ kind: "unreachable", detail: "remote context" });
    expect(mocks.runSpawn).not.toHaveBeenCalled();
  });
});

describe("bringUpDb", () => {
  it("brings up the db service alone and proves it is this install's database", async () => {
    expect(await source().bringUpDb(ID, {})).toEqual({ kind: "ready", pgPort: 27999, passwordPath: PASSWORD });
    expect(mocks.renderCompose).toHaveBeenCalledWith(expect.anything(), { pgPort: 27999 });
    expect(mocks.composeUpDetached).toHaveBeenCalledTimes(1);
    expect(mocks.composeUpDetached.mock.calls[0]?.[0]).toMatchObject({ composeDir: COMPOSE_DIR, services: ["db"] });
    expect(mocks.waitForHealth).toHaveBeenCalledWith(
      expect.objectContaining({ pgPort: 27999, pgPasswordPath: PASSWORD, installId: ID }),
    );
  });

  it("without a fixed port, publishes on this install's port when free, else any free one", async () => {
    mocks.chooseFreePort.mockResolvedValueOnce(41_234);
    expect(await source(null).bringUpDb(ID, {})).toMatchObject({ kind: "ready", pgPort: 41_234 });
    expect(mocks.chooseFreePort).toHaveBeenCalledWith([resolvePgPort()]);
    expect(mocks.renderCompose).toHaveBeenCalledWith(expect.anything(), { pgPort: 41_234 });
    expect(mocks.waitForHealth).toHaveBeenCalledWith(expect.objectContaining({ pgPort: 41_234 }));
  });

  it("NEVER runs `up` when the volume is gone: up would create an empty one", async () => {
    volume("absent");
    expect(await source().bringUpDb(ID, {})).toMatchObject({ kind: "no_volume" });
    expect(mocks.renderCompose).not.toHaveBeenCalled();
    expect(mocks.composeUpDetached).not.toHaveBeenCalled();
  });

  it("refuses a project re-rendered for another install id", async () => {
    mocks.renderCompose.mockResolvedValueOnce({ outPath: path.join(COMPOSE_DIR, "docker-compose.yml"), installId: "other", pgPasswordComposePath: PASSWORD, embedPort: 1 });
    expect(await source().bringUpDb(ID, {})).toMatchObject({ kind: "failed" });
    expect(mocks.composeUpDetached).not.toHaveBeenCalled();
  });

  it.each([
    ["the endpoint policy", () => mocks.inspectDockerEndpointPolicy.mockResolvedValueOnce({ accepted: false, message: "tcp://remote" })],
    ["the compose floor", () => mocks.checkComposeFloor.mockResolvedValueOnce("Docker Compose 2.20 is below 2.23.1")],
    ["the daemon", () => mocks.ensureDockerDaemonReady.mockResolvedValueOnce({ kind: "user_action_required", message: "start Docker Desktop" })],
  ])("Docker unavailable at %s", async (_label, arrange) => {
    arrange();
    expect(await source().bringUpDb(ID, {})).toMatchObject({ kind: "docker_unavailable" });
    expect(mocks.composeUpDetached).not.toHaveBeenCalled();
  });

  it("recreates the db container (never --volumes) on Docker Desktop's stale bind-mount cache", async () => {
    mocks.composeUpDetached.mockResolvedValueOnce(exit(1, "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/abc: no such file or directory"));
    mocks.recreateProjectNonDestructively.mockResolvedValueOnce({ downResult: ok(), upResult: ok() });
    expect(await source().bringUpDb(ID, {})).toMatchObject({ kind: "ready" });
    expect(mocks.recreateProjectNonDestructively.mock.calls[0]?.[0]).toMatchObject({ installId: ID, services: ["db"] });
  });

  it("a failed up, or a database that is not ours, is a failure", async () => {
    mocks.composeUpDetached.mockResolvedValueOnce(exit(1, "Bind for 127.0.0.1:27999 failed: port is already allocated"));
    expect(await source().bringUpDb(ID, {})).toMatchObject({ kind: "failed", message: expect.stringContaining("port is already allocated") });
    mocks.waitForHealth.mockResolvedValueOnce({ verdict: "foreign_listener", message: "another database" });
    expect(await source().bringUpDb(ID, {})).toEqual({ kind: "failed", message: "another database" });
  });
});

describe("stop and removeData", () => {
  it("stop is composeDown: `compose stop`, never down", async () => {
    expect(await source().stop(ID)).toEqual({ kind: "stopped", message: "stopped" });
    expect(mocks.composeDown).toHaveBeenCalledWith(path.join(COMPOSE_DIR, "docker-compose.yml"), ID, undefined);
  });

  it("removeData runs `down --volumes` for this project only and confirms the volume is gone", async () => {
    let removed = false;
    mocks.runSpawn.mockImplementation(async (_cmd: string, args: readonly string[]) => {
      if (args[0] === "compose") {
        removed = true;
        return ok();
      }
      return removed ? exit(1, "no such volume") : ok(`vex-postgres-data-${ID}\n`);
    });
    expect(await source().removeData(ID)).toMatchObject({ kind: "removed" });
    expect(mocks.runSpawn).toHaveBeenCalledWith(
      "docker",
      ["compose", "-p", `vex-${ID}`, "down", "--volumes", "--remove-orphans"],
      expect.objectContaining({ cwd: COMPOSE_DIR }),
    );
  });

  it("removeData reports a volume that survived", async () => {
    volume("present");
    expect(await source().removeData(ID)).toMatchObject({ kind: "failed" });
  });

  it("removeData with Docker unavailable runs nothing", async () => {
    mocks.checkDockerDaemon.mockResolvedValueOnce({ ok: false, reason: "down" });
    expect(await source().removeData(ID)).toEqual({ kind: "docker_unavailable", message: "down" });
    expect(mocks.runSpawn).not.toHaveBeenCalled();
  });
});
