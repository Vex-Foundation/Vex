/**
 * Verifies dockerStatusSchema is strict (rejects unknown keys, missing
 * fields, wrong types). Strictness is the M2 contract that prevents
 * handler drift breaking renderer code silently.
 */

import { describe, expect, it } from "vitest";
import {
  composeUpResultSchema,
  dockerStatusSchema,
  stopPreviousInstallStacksResultSchema,
  type DockerStatus,
} from "../docker.js";

const validStatus: DockerStatus = {
  endpoint: {
    accepted: true,
    currentContext: "default",
    dockerHostSet: false,
    reason: null,
    message: null,
  },
  engine: {
    state: { kind: "ready" },
    version: "27.5.1",
    cliSource: "install_dir",
    present: true,
    runtimeOK: true,
  },
  compose: { present: true, version: "v2.32.4" },
  modelRunner: { present: true, status: "active", tcpReachable: true },
  daemon: { running: true, startable: true },
  ports: { vexPgFree: true },
  disk: { availableGB: 42.5 },
};

describe("dockerStatusSchema", () => {
  it("accepts a fully populated valid status", () => {
    expect(dockerStatusSchema.safeParse(validStatus).success).toBe(true);
  });

  it("accepts null engine version when engine missing", () => {
    const status: DockerStatus = {
      ...validStatus,
      engine: {
        state: { kind: "not_installed" },
        version: null,
        cliSource: null,
        present: false,
        runtimeOK: false,
      },
    };
    expect(dockerStatusSchema.safeParse(status).success).toBe(true);
  });

  it("rejects unknown keys (strict objects)", () => {
    const result = dockerStatusSchema.safeParse({
      ...validStatus,
      ports: { vexPgFree: true, extraKey: "leak" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative disk space", () => {
    const result = dockerStatusSchema.safeParse({
      ...validStatus,
      disk: { availableGB: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown modelRunner status enum", () => {
    const result = dockerStatusSchema.safeParse({
      ...validStatus,
      modelRunner: {
        present: true,
        status: "running" as never,
        tcpReachable: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown engine failure categories", () => {
    const result = dockerStatusSchema.safeParse({
      ...validStatus,
      engine: { ...validStatus.engine, failure: "docker_broken" },
    });
    expect(result.success).toBe(false);
  });
});

describe("compose previous-install contracts", () => {
  const composeResult = {
    kind: "port_collision",
    composeOutPath: "/tmp/docker-compose.yml",
    installId: "11111111-2222-4333-8444-555555555555",
    message: "A required port is occupied.",
    previousInstallHoldingPorts: true,
  };

  it("requires the previous-install collision boolean", () => {
    expect(composeUpResultSchema.safeParse(composeResult).success).toBe(true);
    const { previousInstallHoldingPorts: _removed, ...missing } = composeResult;
    expect(composeUpResultSchema.safeParse(missing).success).toBe(false);
  });

  it("keeps stop output strict and identifier-free", () => {
    expect(
      stopPreviousInstallStacksResultSchema.safeParse({
        stoppedCount: 2,
        message: "Stopped previous Vex services.",
      }).success,
    ).toBe(true);
    expect(
      stopPreviousInstallStacksResultSchema.safeParse({
        stoppedCount: 2,
        message: "Stopped previous Vex services.",
        containerIds: ["secret-internal-id"],
      }).success,
    ).toBe(false);
  });
});
