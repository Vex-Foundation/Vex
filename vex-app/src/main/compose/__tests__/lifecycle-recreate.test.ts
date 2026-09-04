/**
 * Tests for the WP-B self-heal wiring (issue #26): both stale-bind-mount
 * failure branches in `composeUp` must attempt ONE non-destructive recreate
 * (`recreateProjectNonDestructively`) before giving up —
 *   (a) the primary post-setup dead-end (destructive wipe refused), and
 *   (b) the reused-stack convergence branch's `up -d` failure.
 * The destructive `clearStaleSecretCache` path (pre-setup only) stays
 * untouched; these tests pin that its behavior/callers are unaffected.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderDeps } from "../render.js";

const STALE_STDERR =
  'error mounting "docker-desktop-bind-mounts/Ubuntu/deadbeef" to rootfs: no such file or directory';

const mocks = vi.hoisted(() => ({
  renderCompose: vi.fn(),
  inspectEndpoint: vi.fn(),
  checkComposeFloor: vi.fn(),
  ensureDaemon: vi.fn(),
  isPortFree: vi.fn(),
  isOurProjectActive: vi.fn(),
  findPrevious: vi.fn(),
  waitForHealth: vi.fn(),
  waitForEmbeddingsRuntimeReady: vi.fn(),
  clearStaleSecretCache: vi.fn(),
  composePull: vi.fn(),
  composeUpDetached: vi.fn(),
  recreateProjectNonDestructively: vi.fn(),
}));

vi.mock("../render.js", () => ({ renderCompose: mocks.renderCompose }));
vi.mock("../preflight.js", () => ({
  inspectDockerEndpointPolicy: mocks.inspectEndpoint,
  checkComposeFloor: mocks.checkComposeFloor,
  ensureDockerDaemonReady: mocks.ensureDaemon,
  isPortFree: mocks.isPortFree,
}));
vi.mock("../health.js", () => ({
  HEALTH_TIMEOUT_MS: 1,
  isOurProjectActive: mocks.isOurProjectActive,
  waitForHealth: mocks.waitForHealth,
}));
vi.mock("../orphan-stacks.js", () => ({
  findPreviousInstallContainersHoldingPorts: mocks.findPrevious,
}));
vi.mock("../embeddings-health.js", () => ({
  waitForEmbeddingsRuntimeReady: mocks.waitForEmbeddingsRuntimeReady,
}));
vi.mock("../stale-secret-recovery.js", () => ({
  clearStaleSecretCache: mocks.clearStaleSecretCache,
  STALE_BIND_MOUNT_RE: /no such file or directory/,
}));
vi.mock("../up.js", () => ({
  PULL_TIMEOUT_MS: 1,
  UP_TIMEOUT_MS: 1,
  composePull: mocks.composePull,
  composeUpDetached: mocks.composeUpDetached,
}));
vi.mock("../recreate.js", () => ({
  recreateProjectNonDestructively: mocks.recreateProjectNonDestructively,
}));

import { composeUp } from "../lifecycle.js";

const deps: RenderDeps = {
  userDataDir: "/tmp/user-data",
  resourcesDir: "/tmp/resources",
  secretAdapter: {
    write: async (targetPath) => ({ composePath: targetPath }),
    read: async () => null,
    cleanup: async () => {},
    bootCleanup: async () => {},
  },
  randomAdapter: {
    uuid: () => "11111111-2222-4333-8444-555555555555",
    randomBytes: (size) => new Uint8Array(size),
  },
  cryptoAdapter: { base64url: () => "test" },
};

function spawnResult(partial: Partial<{
  code: number | null;
  stderr: string;
  timedOut: boolean;
}> = {}) {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    aborted: false,
    timedOut: false,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectEndpoint.mockResolvedValue({ accepted: true });
  mocks.checkComposeFloor.mockResolvedValue(null);
  mocks.ensureDaemon.mockResolvedValue({ kind: "ready" });
  mocks.renderCompose.mockResolvedValue({
    outPath: "/tmp/compose/docker-compose.yml",
    installId: "11111111-2222-4333-8444-555555555555",
    embedPort: 27134,
    pgPasswordComposePath: "/tmp/secrets/pg_password",
  });
  mocks.isPortFree.mockResolvedValue(true);
  mocks.composePull.mockResolvedValue(spawnResult());
  mocks.waitForHealth.mockResolvedValue({
    verdict: "usable",
    message: "Postgres on 127.0.0.1:27432 is this install's database.",
  });
  mocks.waitForEmbeddingsRuntimeReady.mockResolvedValue({
    kind: "ready",
    observedDim: 384,
  });
});

describe("composeUp - post-setup stale bind-mount branch (primary up path)", () => {
  beforeEach(() => {
    mocks.composeUpDetached.mockResolvedValueOnce(
      spawnResult({ code: 1, stderr: STALE_STDERR }),
    );
    mocks.clearStaleSecretCache.mockResolvedValue({ wiped: false });
  });

  it("attempts exactly ONE non-destructive recreate, and recovers on success", async () => {
    mocks.recreateProjectNonDestructively.mockResolvedValueOnce({
      downResult: spawnResult(),
      upResult: spawnResult({ code: 0 }),
    });

    const result = await composeUp(deps);

    expect(mocks.recreateProjectNonDestructively).toHaveBeenCalledTimes(1);
    // Destructive wipe was refused (setup complete) — never re-renders /
    // regenerates the secret on this path.
    expect(mocks.renderCompose).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("running");
  });

  it("passes project scoping through to the recreate helper (installId + composeDir)", async () => {
    mocks.recreateProjectNonDestructively.mockResolvedValueOnce({
      downResult: spawnResult(),
      upResult: spawnResult({ code: 0 }),
    });

    await composeUp(deps);

    const call = mocks.recreateProjectNonDestructively.mock.calls[0]![0] as {
      installId: string;
      composeDir: string;
    };
    expect(call.installId).toBe("11111111-2222-4333-8444-555555555555");
    expect(call.composeDir).toBe("/tmp/compose");
  });

  it("surfaces a failure WITHOUT the 'contact support to recover your keys' phishing-style phrasing when recreate also fails", async () => {
    mocks.recreateProjectNonDestructively.mockResolvedValueOnce({
      downResult: spawnResult(),
      upResult: spawnResult({ code: 1, stderr: STALE_STDERR }),
    });

    const result = await composeUp(deps);

    expect(mocks.recreateProjectNonDestructively).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("failed");
    expect(result.message).not.toMatch(/contact support.*recover your keys/i);
    expect(result.message).toMatch(/never ask/i);
    expect(result.message).toMatch(/seed phrase|private key/i);
  });

  it("does not touch the destructive wipe path beyond the existing pre-gate call", async () => {
    mocks.recreateProjectNonDestructively.mockResolvedValueOnce({
      downResult: spawnResult(),
      upResult: spawnResult({ code: 0 }),
    });

    await composeUp(deps);

    // clearStaleSecretCache is still called once (the existing gate check);
    // the non-destructive recreate must not trigger any ADDITIONAL
    // destructive-wipe call.
    expect(mocks.clearStaleSecretCache).toHaveBeenCalledTimes(1);
  });
});

describe("composeUp - reused-stack convergence branch (port-busy path)", () => {
  beforeEach(() => {
    mocks.isPortFree
      .mockResolvedValueOnce(false) // pg port busy
      .mockResolvedValueOnce(true); // embed port free
    mocks.isOurProjectActive.mockResolvedValue(true);
  });

  it("applies the stale-signature match BEFORE falling through to health probes, with exactly one recreate attempt", async () => {
    mocks.composeUpDetached.mockResolvedValueOnce(
      spawnResult({ code: 1, stderr: STALE_STDERR }),
    );
    mocks.recreateProjectNonDestructively.mockResolvedValueOnce({
      downResult: spawnResult(),
      upResult: spawnResult({ code: 0 }),
    });

    const result = await composeUp(deps, { pgPort: 27432 });

    expect(mocks.recreateProjectNonDestructively).toHaveBeenCalledTimes(1);
    // Health probes still run afterward regardless of recreate's outcome.
    expect(mocks.waitForHealth).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("reused");
  });

  it("falls through to health probes without recreating when the reuse-up failure is NOT the stale-mount signature", async () => {
    mocks.composeUpDetached.mockResolvedValueOnce(
      spawnResult({ code: 1, stderr: "some other transient failure" }),
    );

    await composeUp(deps, { pgPort: 27432 });

    expect(mocks.recreateProjectNonDestructively).not.toHaveBeenCalled();
    expect(mocks.waitForHealth).toHaveBeenCalledTimes(1);
  });

  it("still falls through to health probes when the recreate retry itself fails", async () => {
    mocks.composeUpDetached.mockResolvedValueOnce(
      spawnResult({ code: 1, stderr: STALE_STDERR }),
    );
    mocks.recreateProjectNonDestructively.mockResolvedValueOnce({
      downResult: spawnResult(),
      upResult: spawnResult({ code: 1, stderr: STALE_STDERR }),
    });
    mocks.waitForHealth.mockResolvedValueOnce({
      verdict: "unreachable",
      message: "127.0.0.1:27432 did not answer usably: timeout expired.",
    });

    const result = await composeUp(deps, { pgPort: 27432 });

    expect(mocks.recreateProjectNonDestructively).toHaveBeenCalledTimes(1);
    expect(mocks.waitForHealth).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("unhealthy");
  });
});
