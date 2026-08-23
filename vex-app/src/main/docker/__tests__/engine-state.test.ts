/**
 * The state union itself: `classifyEngineState` must resolve six distinct
 * outcomes and must never let the endpoint hint contradict a successful
 * `docker info`, plus the bounded window that is the ONLY honest source of
 * `engine_starting`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { classifyEngineState } from "../probe/daemon.js";
import {
  ENGINE_START_WINDOW_MS,
  clearDockerEngineStartWindow,
  isWithinEngineStartWindow,
  markDockerEngineStartAttempt,
} from "../engine-start-window.js";
import { deriveDockerStatusFlags } from "@shared/schemas/docker.js";

const acceptedEndpoint = {
  accepted: true,
  currentContext: "default",
  dockerHostSet: false,
  reason: null,
  message: null,
} as const;

const baseInput = {
  cliFound: true,
  versionOk: true,
  version: "27.5.1",
  versionErrorMessage: null,
  endpoint: acceptedEndpoint,
  daemonRunning: false,
  reachability: { kind: "not_running" } as const,
  startWindowOpen: false,
};

describe("classifyEngineState", () => {
  it("reports not_installed only when no CLI was located", () => {
    expect(
      classifyEngineState({ ...baseInput, cliFound: false }),
    ).toEqual({ kind: "not_installed" });
  });

  it("reports a located-but-unusable CLI as a probe error, never as not_installed", () => {
    const state = classifyEngineState({
      ...baseInput,
      versionOk: false,
      version: null,
      versionErrorMessage: "spawn EACCES",
    });
    expect(state.kind).toBe("error");
    expect(state).toMatchObject({ reason: "probe_error" });
  });

  it("treats unparseable version output as a probe error", () => {
    expect(
      classifyEngineState({ ...baseInput, version: null }).kind,
    ).toBe("error");
  });

  it("surfaces a rejected endpoint as its own error reason and message", () => {
    const state = classifyEngineState({
      ...baseInput,
      endpoint: {
        accepted: false,
        currentContext: "remote",
        dockerHostSet: true,
        reason: "docker_host_unsupported",
        message: "DOCKER_HOST points at a remote endpoint.",
      },
    });
    expect(state).toEqual({
      kind: "error",
      reason: "endpoint_rejected",
      message: "DOCKER_HOST points at a remote endpoint.",
    });
  });

  it("reports ready when the daemon answered", () => {
    expect(
      classifyEngineState({ ...baseInput, daemonRunning: true }),
    ).toEqual({ kind: "ready" });
  });

  it("never lets the endpoint hint contradict a successful docker info", () => {
    // A custom Docker context puts the engine on an endpoint this probe does
    // not know about, so `not_running` there must not override `ready`.
    expect(
      classifyEngineState({
        ...baseInput,
        daemonRunning: true,
        reachability: { kind: "not_running" },
      }),
    ).toEqual({ kind: "ready" });
  });

  it("reports permission_denied with actionable text rather than a generic failure", () => {
    const state = classifyEngineState({
      ...baseInput,
      reachability: { kind: "permission_denied", endpoint: "/var/run/docker.sock" },
    });
    expect(state.kind).toBe("permission_denied");
    expect(state).toMatchObject({ message: expect.stringMatching(/Docker/) });
  });

  it("reports engine_starting only inside the bounded start window", () => {
    expect(
      classifyEngineState({ ...baseInput, startWindowOpen: true }),
    ).toEqual({ kind: "engine_starting" });
    expect(
      classifyEngineState({ ...baseInput, startWindowOpen: false }),
    ).toEqual({ kind: "engine_stopped" });
  });

  it("does not infer engine_starting from an unknown endpoint outcome", () => {
    expect(
      classifyEngineState({
        ...baseInput,
        reachability: { kind: "unknown", errorCode: "ETIMEDOUT" },
      }),
    ).toEqual({ kind: "engine_stopped" });
  });
});

describe("engine start window", () => {
  afterEach(() => {
    clearDockerEngineStartWindow();
  });

  it("is closed until a start attempt is recorded", () => {
    expect(isWithinEngineStartWindow()).toBe(false);
  });

  it("opens on a start attempt and expires after the bounded window", () => {
    markDockerEngineStartAttempt(1_000);
    expect(isWithinEngineStartWindow(1_000 + ENGINE_START_WINDOW_MS - 1)).toBe(
      true,
    );
    expect(isWithinEngineStartWindow(1_000 + ENGINE_START_WINDOW_MS)).toBe(
      false,
    );
  });

  it("can be closed explicitly once the engine answers", () => {
    markDockerEngineStartAttempt();
    clearDockerEngineStartWindow();
    expect(isWithinEngineStartWindow()).toBe(false);
  });
});

describe("deriveDockerStatusFlags", () => {
  it("derives every legacy boolean from one state, with no second source", () => {
    expect(deriveDockerStatusFlags({ kind: "ready" })).toEqual({
      present: true,
      runtimeOK: true,
      daemonRunning: true,
      daemonStartable: true,
    });
    expect(deriveDockerStatusFlags({ kind: "engine_stopped" })).toEqual({
      present: true,
      runtimeOK: false,
      daemonRunning: false,
      daemonStartable: true,
    });
    expect(deriveDockerStatusFlags({ kind: "not_installed" })).toEqual({
      present: false,
      runtimeOK: false,
      daemonRunning: false,
      daemonStartable: false,
    });
    expect(
      deriveDockerStatusFlags({
        kind: "error",
        reason: "probe_error",
        message: "x",
      }),
    ).toEqual({
      present: false,
      runtimeOK: false,
      daemonRunning: false,
      daemonStartable: false,
    });
  });
});
