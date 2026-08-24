/**
 * UpdateStatus contract tests (M13). The discriminated union is validated at
 * BOTH boundaries (main output + preload subscribe), so the redaction guarantee
 * rides on `.strict()` rejecting any extra key (e.g. an artifact path that
 * leaked through a mapping bug).
 */

import { describe, expect, it } from "vitest";
import {
  releaseNotesOpenedSchema,
  updateCancelledSchema,
  updateRestartingSchema,
  updateStartedSchema,
  updateStatusSchema,
} from "../updater.js";

describe("updateStatusSchema", () => {
  const valid = [
    { kind: "idle", currentVersion: "1.0.0" },
    { kind: "checking", currentVersion: "1.0.0" },
    {
      kind: "current",
      currentVersion: "1.0.0",
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      kind: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      severity: "normal",
    },
    {
      kind: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      severity: "security",
      releaseDate: "2026-01-01",
      summary: "What's new",
    },
    {
      kind: "blockedByOperation",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      reason: "An agent run is still in progress.",
      blockedAction: "download",
      severity: "normal",
      wasDownloaded: false,
    },
    {
      kind: "blockedByOperation",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      reason: "A database migration is still running.",
      blockedAction: "install",
      severity: "critical",
      releaseDate: "2026-01-01",
      summary: "Security fix",
      wasDownloaded: true,
    },
    {
      kind: "downloading",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      percent: 42,
    },
    {
      kind: "downloading",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      percent: 0,
      bytesPerSecond: 10,
      transferred: 5,
      total: 100,
    },
    { kind: "downloaded", currentVersion: "1.0.0", latestVersion: "1.1.0" },
    { kind: "installing", currentVersion: "1.0.0", latestVersion: "1.1.0" },
    { kind: "error", currentVersion: "1.0.0", message: "Update failed.", retryable: true },
  ] as const;

  it("accepts every documented variant", () => {
    for (const variant of valid) {
      expect(updateStatusSchema.safeParse(variant).success).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(
      updateStatusSchema.safeParse({ kind: "boom", currentVersion: "1.0.0" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing required field (available without latestVersion)", () => {
    expect(
      updateStatusSchema.safeParse({
        kind: "available",
        currentVersion: "1.0.0",
        severity: "normal",
      }).success,
    ).toBe(false);
  });

  it("rejects an extra key - a leaked artifact path must not pass", () => {
    expect(
      updateStatusSchema.safeParse({
        kind: "downloaded",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        path: "/Users/x/Library/Caches/vex/Vex-1.1.0.dmg",
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range percent", () => {
    expect(
      updateStatusSchema.safeParse({
        kind: "downloading",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        percent: 150,
      }).success,
    ).toBe(false);
  });

  it("rejects blockedByOperation missing the new recovery-context fields", () => {
    expect(
      updateStatusSchema.safeParse({
        kind: "blockedByOperation",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        reason: "busy",
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid blockedAction value", () => {
    expect(
      updateStatusSchema.safeParse({
        kind: "blockedByOperation",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        reason: "busy",
        blockedAction: "boot",
        severity: "normal",
        wasDownloaded: false,
      }).success,
    ).toBe(false);
  });
});

describe("updater ack schemas", () => {
  it("accept the literal true ack", () => {
    expect(updateStartedSchema.safeParse({ started: true }).success).toBe(true);
    expect(updateCancelledSchema.safeParse({ cancelled: true }).success).toBe(
      true,
    );
    expect(updateRestartingSchema.safeParse({ restarting: true }).success).toBe(
      true,
    );
    expect(releaseNotesOpenedSchema.safeParse({ opened: true }).success).toBe(
      true,
    );
  });

  it("reject false or extra keys", () => {
    expect(updateStartedSchema.safeParse({ started: false }).success).toBe(
      false,
    );
    expect(
      updateStartedSchema.safeParse({ started: true, extra: 1 }).success,
    ).toBe(false);
  });
});
