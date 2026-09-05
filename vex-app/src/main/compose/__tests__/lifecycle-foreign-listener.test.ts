/**
 * `composeUp` must never declare a stack usable to the app when the
 * published Postgres port is served by another install's database.
 *
 * This is the data-integrity half of the shadowed-port defect: Compose
 * says the project is running and the container is healthy, so every
 * signal except the app's own connection agrees the stack is fine. The
 * assertions below pin the two things that protect user data - the
 * result kind is never `running`/`reused` (the only kinds that let the
 * migration runner take the connection), and the embeddings probe never
 * runs on a stack we already know we cannot use.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderDeps } from "../render.js";

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
  composePull: vi.fn(),
  composeUpDetached: vi.fn(),
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
  clearStaleSecretCache: vi.fn(),
  STALE_BIND_MOUNT_RE: /never/,
}));
vi.mock("../up.js", () => ({
  PULL_TIMEOUT_MS: 1,
  UP_TIMEOUT_MS: 1,
  composePull: mocks.composePull,
  composeUpDetached: mocks.composeUpDetached,
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

function spawnResult() {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    aborted: false,
    timedOut: false,
  };
}

const FOREIGN = {
  verdict: "foreign_listener" as const,
  message:
    "127.0.0.1:27432 rejects this install's credentials while this install's own database container accepts them.",
};

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
  mocks.composeUpDetached.mockResolvedValue(spawnResult());
  mocks.waitForEmbeddingsRuntimeReady.mockResolvedValue({
    kind: "ready",
    observedDim: 768,
    message: "ready",
  });
});

describe("composeUp - foreign listener on the published Postgres port", () => {
  it("reports foreign_listener on the fresh-start path and stops before the embeddings probe", async () => {
    mocks.waitForHealth.mockResolvedValue(FOREIGN);

    const result = await composeUp(deps, { pgPort: 27432 });

    expect(result.kind).toBe("foreign_listener");
    expect(result.message).toContain("27432");
    expect(result.embeddingsReadiness).toBeNull();
    expect(mocks.waitForEmbeddingsRuntimeReady).not.toHaveBeenCalled();
  });

  it("reports foreign_listener on the reuse path instead of reusing another install's database", async () => {
    // The measured shape of the incident: the port is busy AND our own
    // project's containers are running and healthy, so the reuse branch
    // is the one that would have handed the app a foreign database.
    mocks.isPortFree.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.isOurProjectActive.mockResolvedValue(true);
    mocks.waitForHealth.mockResolvedValue(FOREIGN);

    const result = await composeUp(deps, { pgPort: 27432 });

    expect(result.kind).toBe("foreign_listener");
    expect(mocks.waitForEmbeddingsRuntimeReady).not.toHaveBeenCalled();
  });

  it("passes this install's id to the probe so the corroboration targets our own container", async () => {
    mocks.waitForHealth.mockResolvedValue(FOREIGN);

    await composeUp(deps, { pgPort: 27432 });

    expect(mocks.waitForHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        installId: "11111111-2222-4333-8444-555555555555",
        pgPort: 27432,
      })
    );
  });

  it("keeps a stale-credentials verdict out of the foreign_listener kind", async () => {
    mocks.waitForHealth.mockResolvedValue({
      verdict: "stale_credentials",
      message:
        "This install's stored Postgres password no longer matches its database volume.",
    });

    const result = await composeUp(deps, { pgPort: 27432 });

    expect(result.kind).toBe("unhealthy");
    expect(result.message).toMatch(/no longer matches/i);
  });
});
