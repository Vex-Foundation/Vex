/**
 * Error triage for the CLI-independent engine liveness probe. The contract
 * under test is that a connection failure is classified into distinct
 * outcomes rather than one generic failure, and that the candidate list is
 * walked until the most informative answer is found.
 *
 * `connect` is injected, so no socket or named pipe is opened here.
 */

import { describe, expect, it, vi } from "vitest";

import {
  classifyConnectError,
  defaultDockerEngineEndpoints,
  probeDockerEngineEndpoint,
  probeEngineEndpointOnce,
  type DockerEngineReachability,
} from "../engine-endpoint.js";

describe("defaultDockerEngineEndpoints", () => {
  it("uses the documented Windows named pipe", () => {
    expect(
      defaultDockerEngineEndpoints({ platform: "win32", homedir: "C:\\U" }),
    ).toEqual(["\\\\.\\pipe\\docker_engine"]);
  });

  it("tries the per-user Docker Desktop socket before /var/run on darwin", () => {
    expect(
      defaultDockerEngineEndpoints({ platform: "darwin", homedir: "/Users/t" }),
    ).toEqual(["/Users/t/.docker/run/docker.sock", "/var/run/docker.sock"]);
  });

  it("has no endpoint on an unsupported platform", () => {
    expect(
      defaultDockerEngineEndpoints({ platform: "aix", homedir: "/h" }),
    ).toEqual([]);
  });
});

describe("classifyConnectError", () => {
  it.each(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"])(
    "treats %s as nothing listening",
    (code) => {
      expect(classifyConnectError(code, "/sock")).toEqual({
        kind: "not_running",
      });
    },
  );

  it.each(["EACCES", "EPERM"])(
    "treats %s as a permission denial, carrying the endpoint",
    (code) => {
      expect(classifyConnectError(code, "/sock")).toEqual({
        kind: "permission_denied",
        endpoint: "/sock",
      });
    },
  );

  it("keeps an unrecognised or absent errno as unknown", () => {
    expect(classifyConnectError("EHOSTUNREACH", "/sock")).toEqual({
      kind: "unknown",
      errorCode: "EHOSTUNREACH",
    });
    expect(classifyConnectError(null, "/sock")).toEqual({
      kind: "unknown",
      errorCode: null,
    });
  });
});

describe("probeDockerEngineEndpoint triage", () => {
  function withConnect(
    responses: Record<string, DockerEngineReachability>,
  ): (endpoint: string) => Promise<DockerEngineReachability> {
    return (endpoint) =>
      Promise.resolve(responses[endpoint] ?? { kind: "not_running" });
  }

  it("reports reachable when an endpoint accepts the connection", async () => {
    const result = await probeDockerEngineEndpoint({
      platform: "linux",
      homedir: "/home/t",
      connect: withConnect({
        "/var/run/docker.sock": { kind: "reachable", endpoint: "/var/run/docker.sock" },
      }),
    });
    expect(result).toEqual({ kind: "reachable", endpoint: "/var/run/docker.sock" });
  });

  it("keeps permission denied distinct from not running", async () => {
    const result = await probeDockerEngineEndpoint({
      platform: "linux",
      homedir: "/home/t",
      connect: withConnect({
        "/var/run/docker.sock": {
          kind: "permission_denied",
          endpoint: "/var/run/docker.sock",
        },
      }),
    });
    expect(result.kind).toBe("permission_denied");
  });

  it("stops at the first reachable endpoint instead of probing the rest", async () => {
    const connect = vi.fn(
      async (endpoint: string): Promise<DockerEngineReachability> =>
        endpoint === "/Users/t/.docker/run/docker.sock"
          ? { kind: "reachable", endpoint }
          : { kind: "not_running" },
    );
    await probeDockerEngineEndpoint({
      platform: "darwin",
      homedir: "/Users/t",
      connect,
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("prefers an unknown error over not_running so a stuck endpoint is not read as absent", async () => {
    const result = await probeDockerEngineEndpoint({
      platform: "darwin",
      homedir: "/Users/t",
      connect: withConnect({
        "/Users/t/.docker/run/docker.sock": {
          kind: "unknown",
          errorCode: "ETIMEDOUT",
        },
      }),
    });
    expect(result).toEqual({ kind: "unknown", errorCode: "ETIMEDOUT" });
  });

  it("reports not_running when nothing is listening anywhere", async () => {
    const result = await probeDockerEngineEndpoint({
      platform: "linux",
      homedir: "/home/t",
      connect: withConnect({}),
    });
    expect(result).toEqual({ kind: "not_running" });
  });

  it("has no reachable endpoint on an unsupported platform", async () => {
    const connect = vi.fn();
    const result = await probeDockerEngineEndpoint({
      platform: "aix",
      homedir: "/h",
      connect,
    });
    expect(result).toEqual({ kind: "not_running" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("probeEngineEndpointOnce", () => {
  it("classifies a missing socket as not_running", async () => {
    const result = await probeEngineEndpointOnce(
      "/nonexistent/vex-docker-probe.sock",
    );
    expect(result).toEqual({ kind: "not_running" });
  });

  it("settles immediately when the caller has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await probeEngineEndpointOnce(
      "/nonexistent/vex-docker-probe.sock",
      controller.signal,
    );
    expect(result).toEqual({ kind: "unknown", errorCode: null });
  });
});
