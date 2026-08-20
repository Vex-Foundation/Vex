/**
 * Smoke test for bug-reports-db lifecycle behavior. The actual DB integration
 * test runs only when `buildPoolConfig()` returns a configuration (i.e. compose
 * has been bootstrapped). Otherwise we assert the unavailable contract.
 *
 * Heavier integration coverage (insert → select → bumpUploadAttempt round-trip)
 * runs in the Playwright/E2E layer where Docker is guaranteed up.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: async () => null,
}));

describe("bug-reports-db - unavailable contract", () => {
  it("throws BugReportsDbUnavailableError when buildPoolConfig returns null", async () => {
    const mod = await import("../bug-reports-db.js");
    await expect(
      mod.insertBugReport({
        id: "00000000-0000-0000-0000-000000000000",
        reportKind: "manual",
        source: "user",
        category: "user_reported_bug",
        severity: "error",
        title: "x",
        description: "",
        appVersion: null,
        osPlatform: null,
        installId: null,
        correlationId: null,
        sessionId: null,
        missionId: null,
        missionRunId: null,
        toolName: null,
        toolCallId: null,
        protocolNamespace: null,
        compactJobId: null,
        stopReason: null,
        runtimeStatus: null,
        contextPressureBand: null,
        contextPressureFraction: null,
        checkpointGeneration: null,
        postCompactBridgeActive: null,
        redactionHardCount: 0,
        redactionMaskCount: 0,
        sanitizedContext: {},
        attachments: [],
        retentionUntil: null,
      }),
    ).rejects.toBeInstanceOf(mod.BugReportsDbUnavailableError);

    await expect(
      mod.listRecentBugReports({ limit: 10 }),
    ).rejects.toBeInstanceOf(mod.BugReportsDbUnavailableError);

    await expect(
      mod.getBugReportById("anything"),
    ).rejects.toBeInstanceOf(mod.BugReportsDbUnavailableError);
  });
});
