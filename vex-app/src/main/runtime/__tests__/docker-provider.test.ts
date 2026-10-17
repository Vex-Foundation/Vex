import { beforeEach, describe, expect, it, vi } from "vitest";

const composeUp = vi.fn();
const composeDown = vi.fn();
const stopStacksHoldingPorts = vi.fn();

vi.mock("../../compose/lifecycle.js", () => ({ composeUp, composeDown }));
vi.mock("../../compose/deps-factory.js", () => ({
  buildRenderDeps: () => ({ userDataDir: "/tmp/fake-user-data" }),
}));
vi.mock("../../compose/orphan-stacks.js", () => ({ stopStacksHoldingPorts }));

const { createDockerProvider } = await import("../docker/docker-provider.js");

function composeResult(kind: string, extra: Record<string, unknown> = {}) {
  return {
    kind,
    composeOutPath: "/cfg/local-infra/compose",
    installId: "install-1",
    message: kind,
    previousInstallHoldingPorts: false,
    conflictPorts: [],
    pgPort: 27432,
    embedPort: 27134,
    pgPasswordPath: "/cfg/local-infra/secrets/pg_password",
    embeddingsReadiness: kind === "running" ? "ready" : null,
    ...extra,
  };
}

const signal = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  composeUp.mockReset();
  composeDown.mockReset();
  stopStacksHoldingPorts.mockReset();
});

describe("docker provider start", () => {
  it("maps a usable stack to loopback db + embeddings endpoints", async () => {
    composeUp.mockResolvedValue(composeResult("running"));
    const outcome = await createDockerProvider().start({}, { signal: signal() });
    expect(outcome.kind).toBe("running");
    expect(outcome.endpoints).toEqual({
      db: { host: "127.0.0.1", pgPort: 27432, pgPasswordPath: "/cfg/local-infra/secrets/pg_password" },
      embeddings: { baseUrl: "http://127.0.0.1:27134/v1", apiKey: null },
    });
    expect(outcome.detail).toMatchObject({ kind: "running", installId: "install-1" });
  });

  it("yields no endpoints for a stack that is not usable", async () => {
    composeUp.mockResolvedValue(composeResult("unhealthy"));
    const outcome = await createDockerProvider().start({}, { signal: signal() });
    expect(outcome).toMatchObject({ kind: "unhealthy", endpoints: null });
  });

  it("passes the port override through and turns an aborted spawn into AbortError", async () => {
    const controller = new AbortController();
    composeUp.mockImplementation(async () => {
      controller.abort();
      return composeResult("failed");
    });
    await expect(
      createDockerProvider().start({ pgPort: 27999 }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(composeUp.mock.calls[0]?.[1]).toMatchObject({ pgPort: 27999, signal: controller.signal });
  });
});

describe("docker provider stop", () => {
  it("reports not_running before anything was started this session", async () => {
    const outcome = await createDockerProvider().stop();
    expect(outcome.kind).toBe("not_running");
    expect(composeDown).not.toHaveBeenCalled();
  });

  it("stops the project the last start brought up", async () => {
    composeUp.mockResolvedValue(composeResult("running"));
    composeDown.mockResolvedValue({ kind: "stopped", message: "Stopped." });
    const provider = createDockerProvider();
    await provider.start({}, { signal: signal() });
    await expect(provider.stop()).resolves.toEqual({
      kind: "stopped",
      detail: { kind: "stopped", message: "Stopped." },
    });
    expect(composeDown).toHaveBeenCalledWith("/cfg/local-infra/compose", "install-1");
  });
});

describe("docker provider previous-install stop", () => {
  it("is authorized only by a port collision with a previous install, then consumed", async () => {
    const provider = createDockerProvider();
    await expect(provider.stopPreviousInstallStacks(signal())).resolves.toEqual({ kind: "none_eligible" });

    composeUp.mockResolvedValue(
      composeResult("port_collision", { previousInstallHoldingPorts: true, conflictPorts: [27432] }),
    );
    await provider.start({}, { signal: signal() });
    stopStacksHoldingPorts.mockResolvedValue({ ok: true, stoppedCount: 1, message: "Stopped 1." });
    await expect(provider.stopPreviousInstallStacks(signal())).resolves.toEqual({
      kind: "stopped",
      stoppedCount: 1,
      message: "Stopped 1.",
    });
    expect(stopStacksHoldingPorts.mock.calls[0]?.[0]).toMatchObject({
      currentInstallId: "install-1",
      conflictPorts: [27432],
    });
    await expect(provider.stopPreviousInstallStacks(signal())).resolves.toEqual({ kind: "none_eligible" });
  });

  it("keeps the authorization when the stop fails", async () => {
    composeUp.mockResolvedValue(
      composeResult("port_collision", { previousInstallHoldingPorts: true, conflictPorts: [27432] }),
    );
    const provider = createDockerProvider();
    await provider.start({}, { signal: signal() });
    stopStacksHoldingPorts.mockResolvedValue({ ok: false });
    await expect(provider.stopPreviousInstallStacks(signal())).resolves.toEqual({ kind: "failed" });
    stopStacksHoldingPorts.mockResolvedValue({ ok: true, stoppedCount: 1, message: "Stopped 1." });
    await expect(provider.stopPreviousInstallStacks(signal())).resolves.toMatchObject({ kind: "stopped" });
  });
});
