/**
 * Unit tests for the pure compose-version parser and semver helpers under
 * `probe/`. The compose pre-flight the migration runs depends on them - no
 * Docker required.
 */

import { describe, expect, it } from "vitest";
import { parseComposeVersion } from "../probe/parsers.js";
import { COMPOSE_VERSION_FLOOR, parseSemver, semverGte } from "../probe/version.js";

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
