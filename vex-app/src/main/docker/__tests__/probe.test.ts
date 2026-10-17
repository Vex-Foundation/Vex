/**
 * Unit tests for the pure parser and version helpers under `probe/`. The
 * compose pre-flight the migration runs depends on them - no Docker
 * required.
 */

import { describe, expect, it } from "vitest";
import {
  parseComposeVersion,
  parseDaemonRunning,
  parseDockerVersion,
  parseModelStatus,
} from "../probe/parsers.js";
import { COMPOSE_VERSION_FLOOR, parseSemver, semverGte } from "../probe/version.js";

describe("parseDockerVersion", () => {
  it.each([
    ["Docker version 27.5.1, build 9f9e405\n", "27.5.1"],
    ["Docker version 28.0.0-rc.1, build abc\n", "28.0.0-rc.1"],
    ["Docker version 26.1.4+ee, build xyz\n", "26.1.4+ee"],
  ])("extracts %j → %j", (stdout, expected) => {
    expect(parseDockerVersion(stdout)).toBe(expected);
  });

  it.each(["", "garbled output", "docker not found"])(
    "returns null for %j",
    (stdout) => {
      expect(parseDockerVersion(stdout)).toBeNull();
    }
  );
});

describe("parseComposeVersion", () => {
  it.each([
    ["Docker Compose version v2.32.4\n", "v2.32.4"],
    ["Docker Compose version 2.35.0\n", "2.35.0"],
    ["Docker Compose version v2.32.4-desktop.1\n", "v2.32.4-desktop.1"],
  ])("extracts %j → %j", (stdout, expected) => {
    expect(parseComposeVersion(stdout)).toBe(expected);
  });

  it.each(["", "compose: command not found"])(
    "returns null for %j",
    (stdout) => {
      expect(parseComposeVersion(stdout)).toBeNull();
    }
  );
});

describe("parseSemver", () => {
  it.each([
    ["v2.23.1", { major: 2, minor: 23, patch: 1 }],
    ["2.23.1", { major: 2, minor: 23, patch: 1 }],
    ["v2.23.1-desktop.1", { major: 2, minor: 23, patch: 1 }],
    ["2.39.2+meta", { major: 2, minor: 39, patch: 2 }],
    ["v2.40.0-rc.2", { major: 2, minor: 40, patch: 0 }],
    ["27.5.1", { major: 27, minor: 5, patch: 1 }],
  ])("parses %j → %j", (input, expected) => {
    expect(parseSemver(input)).toEqual(expected);
  });

  it.each([null, "", "v2", "v2.23", "abc", "2.x.0"])(
    "returns null for %j",
    (input) => {
      expect(parseSemver(input)).toBeNull();
    }
  );
});

describe("semverGte", () => {
  it.each([
    // Equal
    ["2.23.1", "2.23.1", true],
    // Higher patch
    ["2.23.2", "2.23.1", true],
    // Higher minor
    ["2.24.0", "2.23.1", true],
    // Higher major
    ["3.0.0", "2.23.1", true],
    // Lower patch
    ["2.23.0", "2.23.1", false],
    // Lower minor
    ["2.22.5", "2.23.1", false],
    // Lower major
    ["1.99.99", "2.23.1", false],
    // Prefix/suffix tolerated
    ["v2.23.1-desktop.1", "2.23.1", true],
    ["v2.40.0-rc.2", "2.23.1", true],
  ])("semverGte(%j, %j) === %j", (actual, minimum, expected) => {
    expect(semverGte(actual, minimum)).toBe(expected);
  });

  it("returns false when version is null", () => {
    expect(semverGte(null, "2.23.1")).toBe(false);
  });

  it("COMPOSE_VERSION_FLOOR is 2.23.1 (matches inline-configs floor)", () => {
    expect(COMPOSE_VERSION_FLOOR).toBe("2.23.1");
  });
});

describe("parseModelStatus", () => {
  it("treats `is not a docker command` errors as unsupported", () => {
    expect(parseModelStatus("", "docker model is not a docker command")).toBe(
      "unsupported"
    );
  });

  it("recognizes running output as active", () => {
    expect(parseModelStatus("Docker Model Runner is running", null)).toBe("active");
    expect(parseModelStatus("Status: active", null)).toBe("active");
  });

  it("recognizes stopped output as inactive", () => {
    expect(parseModelStatus("Docker Model Runner is not running", null)).toBe(
      "inactive"
    );
    expect(parseModelStatus("Status: stopped", null)).toBe("inactive");
  });

  it("falls back to inactive on unknown error", () => {
    expect(parseModelStatus("", "permission denied")).toBe("inactive");
  });
});

describe("parseDaemonRunning", () => {
  it("returns true on JSON output with non-empty ServerVersion", () => {
    expect(
      parseDaemonRunning(
        '{"ID":"abc","ServerVersion":"27.5.1","KernelVersion":"6.6.0"}',
        null
      )
    ).toBe(true);
  });

  it("returns false on JSON output with empty/missing ServerVersion", () => {
    expect(parseDaemonRunning('{"ID":"abc","ServerVersion":""}', null)).toBe(false);
    expect(parseDaemonRunning('{"ID":"abc"}', null)).toBe(false);
  });

  it("falls back to text-format when JSON parsing fails", () => {
    expect(
      parseDaemonRunning(
        "Client:\n Version: 27.5.1\nServer Version: 27.5.1\nKernel Version: …",
        null
      )
    ).toBe(true);
    expect(parseDaemonRunning("Client:\n Version: 27.5.1\n", null)).toBe(false);
  });

  it("returns false on connection refused", () => {
    expect(
      parseDaemonRunning(
        "",
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
      )
    ).toBe(false);
  });

  it("returns false on any other error", () => {
    expect(parseDaemonRunning("", "permission denied")).toBe(false);
  });
});
