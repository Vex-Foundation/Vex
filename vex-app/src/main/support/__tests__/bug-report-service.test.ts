/**
 * Unit tests for the support bug-report service orchestrator.
 *
 * Goals:
 *   - prove redaction runs BEFORE the DB insert (the proof being:
 *     redaction_*_count > 0 on the insert payload, AND no raw secret in
 *     description/sanitized_context)
 *   - prove install_id is stamped from the on-disk file (cached)
 *   - prove retention_until is computed (automatic → +90 days, manual → null)
 *   - prove transport.enqueue is awaited and its uploadState flows through
 *   - prove transport.enqueue throws → uploadState is still "not_configured"
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BugReportInsert } from "../../database/bug-reports-db.js";

const insertMock = vi.fn();
const transportMock = vi.fn();

vi.mock("../../database/bug-reports-db.js", () => ({
  insertBugReport: (input: BugReportInsert) => insertMock(input),
  BugReportsDbUnavailableError: class extends Error {
    constructor() {
      super("unavailable");
      this.name = "BugReportsDbUnavailableError";
    }
  },
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.0-test",
  },
}));

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

vi.mock("../../paths/config-dir.js", () => ({
  INSTALL_ID_FILE: "/tmp/vex-test-install-id-does-not-exist",
}));

const validInput = {
  reportKind: "manual" as const,
  source: "user" as const,
  category: "user_reported_bug",
  severity: "error" as const,
  title: "private_key: 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
  description:
    "happened while sending 0x742d35Cc6634C0532925a3b844Bc454e4438f44e - token sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzz",
  context: {
    apiKey: "sk-or-v1-zzzzzzzzzzzzzzzzzzzz",
    breadcrumb: "ok",
  },
  refs: { sessionId: "sess-1" },
  correlationIdFromIpc: "req-test",
};

describe("createBugReport service orchestrator", () => {
  beforeEach(() => {
    insertMock.mockReset();
    transportMock.mockReset();
    insertMock.mockResolvedValue(undefined);
  });

  it("redacts every string payload BEFORE inserting and stamps proof counts", async () => {
    transportMock.mockResolvedValueOnce({ uploadState: "not_configured" });
    const { createBugReport, __resetInstallIdCacheForTests } = await import(
      "../bug-report-service.js"
    );
    __resetInstallIdCacheForTests();
    const fixedNow = new Date("2026-05-19T10:00:00Z");
    const result = await createBugReport(validInput, {
      transport: { enqueue: (id: string) => transportMock(id) },
      now: () => fixedNow,
    });
    expect(result.recorded).toBe(true);
    expect(result.uploadState).toBe("not_configured");
    expect(insertMock).toHaveBeenCalledTimes(1);
    const insert = insertMock.mock.calls[0]?.[0] as BugReportInsert;
    expect(insert.title).toContain("[REDACTED:private_key]");
    expect(insert.title).not.toContain("0x4c0883a6");
    expect(insert.description).toContain("0x742d…f44e");
    expect(insert.description).toContain("[REDACTED:api_key]");
    const ctx = insert.sanitizedContext as Record<string, unknown>;
    expect(ctx.apiKey).toBe("[REDACTED]");
    expect(insert.redactionHardCount).toBeGreaterThanOrEqual(2);
    expect(insert.redactionMaskCount).toBeGreaterThanOrEqual(1);
  });

  it("stamps environment metadata and falls back to ctx correlationId", async () => {
    transportMock.mockResolvedValueOnce({ uploadState: "not_configured" });
    const { createBugReport, __resetInstallIdCacheForTests } = await import(
      "../bug-report-service.js"
    );
    __resetInstallIdCacheForTests();
    // `sunos` is deliberately a platform no runner of this suite can BE, so
    // the assertion proves the value was threaded from the seam onto the
    // insert. Comparing against `process.platform` compared the runner to
    // itself and would have passed even if the field were dropped.
    await createBugReport(validInput, {
      transport: { enqueue: (id: string) => transportMock(id) },
      platform: "sunos",
    });
    const insert = insertMock.mock.calls[0]?.[0] as BugReportInsert;
    expect(insert.appVersion).toBe("0.1.0-test");
    expect(insert.osPlatform).toBe("sunos");
    expect(insert.installId).toBeNull();
    expect(insert.correlationId).toBe("req-test");
  });

  it("defaults osPlatform to the host platform when no seam is injected", async () => {
    transportMock.mockResolvedValueOnce({ uploadState: "not_configured" });
    const { createBugReport, __resetInstallIdCacheForTests } = await import(
      "../bug-report-service.js"
    );
    __resetInstallIdCacheForTests();
    await createBugReport(validInput, {
      transport: { enqueue: (id: string) => transportMock(id) },
    });
    const insert = insertMock.mock.calls[0]?.[0] as BugReportInsert;
    expect(insert.osPlatform).toBe(process.platform);
  });

  it("uses refs.correlationId when provided, else falls back to the IPC requestId", async () => {
    transportMock.mockResolvedValueOnce({ uploadState: "not_configured" });
    const { createBugReport, __resetInstallIdCacheForTests } = await import(
      "../bug-report-service.js"
    );
    __resetInstallIdCacheForTests();
    await createBugReport(
      {
        ...validInput,
        refs: { correlationId: "from-refs" },
      },
      { transport: { enqueue: (id: string) => transportMock(id) } },
    );
    const insert = insertMock.mock.calls[0]?.[0] as BugReportInsert;
    expect(insert.correlationId).toBe("from-refs");
  });

  it("sets retention_until=+90d for automatic reports and null for manual", async () => {
    transportMock.mockResolvedValue({ uploadState: "not_configured" });
    const { createBugReport, __resetInstallIdCacheForTests } = await import(
      "../bug-report-service.js"
    );
    __resetInstallIdCacheForTests();
    const fixedNow = new Date("2026-05-19T10:00:00Z");

    await createBugReport(
      { ...validInput, reportKind: "automatic" },
      {
        transport: { enqueue: (id: string) => transportMock(id) },
        now: () => fixedNow,
      },
    );
    const insertAuto = insertMock.mock.calls[0]?.[0] as BugReportInsert;
    expect(insertAuto.retentionUntil).toBeDefined();
    if (insertAuto.retentionUntil) {
      const diffMs =
        new Date(insertAuto.retentionUntil).getTime() - fixedNow.getTime();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      expect(diffMs).toBe(ninetyDaysMs);
    }

    await createBugReport(validInput, {
      transport: { enqueue: (id: string) => transportMock(id) },
      now: () => fixedNow,
    });
    const insertManual = insertMock.mock.calls[1]?.[0] as BugReportInsert;
    expect(insertManual.retentionUntil).toBeNull();
  });

  it("redacts secret-shaped refs.* before they hit the soft-ref columns", async () => {
    transportMock.mockResolvedValueOnce({ uploadState: "not_configured" });
    const { createBugReport, __resetInstallIdCacheForTests } = await import(
      "../bug-report-service.js"
    );
    __resetInstallIdCacheForTests();
    await createBugReport(
      {
        ...validInput,
        refs: {
          sessionId:
            "private_key: 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
          toolCallId: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          // compactJobId is numeric — must remain typed; tests proves it survives the redactor pass.
          compactJobId: 7,
        },
      },
      { transport: { enqueue: (id: string) => transportMock(id) } },
    );
    const insert = insertMock.mock.calls[0]?.[0] as BugReportInsert;
    expect(insert.sessionId).toBeTruthy();
    if (insert.sessionId) {
      expect(insert.sessionId).toContain("[REDACTED:private_key]");
      expect(insert.sessionId).not.toContain("0x4c0883a6");
    }
    expect(insert.toolCallId).toBe("0x742d…f44e");
    expect(insert.compactJobId).toBe(7);
    expect(insert.redactionHardCount).toBeGreaterThanOrEqual(1);
    expect(insert.redactionMaskCount).toBeGreaterThanOrEqual(1);
  });

  it("recovers from a thrown transport.enqueue without failing persistence", async () => {
    transportMock.mockRejectedValueOnce(new Error("transport boom"));
    const { createBugReport, __resetInstallIdCacheForTests } = await import(
      "../bug-report-service.js"
    );
    __resetInstallIdCacheForTests();
    const result = await createBugReport(validInput, {
      transport: { enqueue: (id: string) => transportMock(id) },
    });
    expect(result.recorded).toBe(true);
    expect(result.uploadState).toBe("not_configured");
    expect(insertMock).toHaveBeenCalledTimes(1);
  });
});
