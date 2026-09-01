/**
 * The bridge-readiness WIRE CONTRACT: what it accepts, what it refuses, and
 * what it must never be able to carry.
 *
 * The refusals matter more than the acceptances here. This payload is produced
 * by a process that reads a shell script and spawns a compiler, and the whole
 * reason the schema is `.strict()` with pattern-bounded version tokens is that
 * either of those can hand main a string a renderer should never see.
 */

import { describe, expect, it } from "vitest";
import {
  studioBridgeReadinessSchema,
  type StudioBridgeReadiness,
} from "../studio-bridge-readiness.js";

const missingDev: StudioBridgeReadiness = {
  kind: "missing_dev",
  platform: "linux",
  requiredGoVersion: "go1.27.0",
  go: { kind: "wrong_version", found: "go1.28.1" },
};

describe("round trip", () => {
  it.each<StudioBridgeReadiness>([
    { kind: "ready" },
    { kind: "missing_packaged" },
    { kind: "unsupported_platform" },
    { kind: "pin_unreadable" },
    missingDev,
    {
      kind: "missing_dev",
      platform: "darwin",
      requiredGoVersion: "go1.27.0",
      go: { kind: "absent" },
    },
    {
      kind: "missing_dev",
      platform: "win32",
      requiredGoVersion: "go1.27.0",
      go: { kind: "unusable" },
    },
    {
      kind: "missing_dev",
      platform: "other",
      requiredGoVersion: "go1.27.0",
      go: { kind: "present" },
    },
  ])("survives parse unchanged: %j", (value) => {
    const parsed = studioBridgeReadinessSchema.parse(value);
    expect(parsed).toEqual(value);
  });
});

describe("invented members are refused", () => {
  it.each([
    { kind: "stale_dev" },
    { kind: "missing" },
    { kind: "ok" },
    {},
  ])("rejects an unknown readiness kind: %j", (value) => {
    expect(studioBridgeReadinessSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an unknown toolchain kind", () => {
    expect(
      studioBridgeReadinessSchema.safeParse({
        ...missingDev,
        go: { kind: "maybe" },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown platform", () => {
    expect(
      studioBridgeReadinessSchema.safeParse({
        ...missingDev,
        platform: "freebsd",
      }).success,
    ).toBe(false);
  });
});

describe("nothing rides along", () => {
  it.each([
    ["a bridge path on ready", { kind: "ready", path: "/home/dev/vex-mcp" }],
    [
      "a resources path on missing_packaged",
      { kind: "missing_packaged", resourcesPath: "/Applications/Vex.app" },
    ],
    ["a path on missing_dev", { ...missingDev, path: "/home/dev/bridge" }],
    [
      "a stderr detail on the toolchain",
      { ...missingDev, go: { kind: "unusable", detail: "PATH=/home/dev/bin" } },
    ],
  ])("rejects %s", (_label, value) => {
    expect(studioBridgeReadinessSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    "/usr/local/go",
    "go 1.27.0",
    "go1.27.0 (built from /home/dev)",
    "",
    `go1.${"9".repeat(40)}`,
  ])("refuses %j as a version token", (found) => {
    expect(
      studioBridgeReadinessSchema.safeParse({
        ...missingDev,
        go: { kind: "wrong_version", found },
      }).success,
    ).toBe(false);
    expect(
      studioBridgeReadinessSchema.safeParse({
        ...missingDev,
        requiredGoVersion: found,
      }).success,
    ).toBe(false);
  });
});

describe("the union's own shape", () => {
  it("does not let a from-source field appear on a packaged failure", () => {
    expect(
      studioBridgeReadinessSchema.safeParse({
        kind: "missing_packaged",
        requiredGoVersion: "go1.27.0",
      }).success,
    ).toBe(false);
  });

  it("requires the toolchain and the pin together on missing_dev", () => {
    expect(
      studioBridgeReadinessSchema.safeParse({
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: "go1.27.0",
      }).success,
    ).toBe(false);
    expect(
      studioBridgeReadinessSchema.safeParse({
        kind: "missing_dev",
        platform: "linux",
        go: { kind: "absent" },
      }).success,
    ).toBe(false);
  });
});
