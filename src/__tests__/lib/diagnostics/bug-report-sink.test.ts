import { describe, expect, it, vi, type Mock } from "vitest";
import {
  noopBugReportSink,
  emitBugReportSafe,
  type BugReportSink,
} from "../../../lib/diagnostics/bug-report-sink.js";

type WarnLogger = (message: string, meta?: Record<string, unknown>) => void;

function makeLogger(): { warn: Mock<WarnLogger>; calls: () => Parameters<WarnLogger>[] } {
  const warn = vi.fn<WarnLogger>();
  return {
    warn,
    calls: () => warn.mock.calls,
  };
}

const SAMPLE_INPUT = {
  source: "agent" as const,
  category: "mission_paused_error",
  severity: "error" as const,
  title: "x",
};

describe("noopBugReportSink", () => {
  it("resolves without doing anything", async () => {
    await expect(noopBugReportSink.emit(SAMPLE_INPUT)).resolves.toBeUndefined();
  });
});

describe("emitBugReportSafe", () => {
  it("delegates to the sink on the happy path", async () => {
    const sink: BugReportSink = { emit: vi.fn().mockResolvedValue(undefined) };
    const logger = makeLogger();
    await emitBugReportSafe(sink, SAMPLE_INPUT, logger);
    expect(sink.emit).toHaveBeenCalledTimes(1);
    expect(sink.emit).toHaveBeenCalledWith(SAMPLE_INPUT);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("swallows a sink throw and logs at warn", async () => {
    const sink: BugReportSink = {
      emit: vi.fn().mockRejectedValue(new Error("rate limited")),
    };
    const logger = makeLogger();
    await expect(
      emitBugReportSafe(sink, SAMPLE_INPUT, logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.calls()[0] ?? [];
    expect(msg).toBe("bug-report.sink.emit_failed");
    expect(meta?.category).toBe("mission_paused_error");
    expect(meta?.error).toBe("rate limited");
  });

  it("never propagates non-Error throws either", async () => {
    const sink: BugReportSink = {
      emit: vi.fn().mockRejectedValue("not an error"),
    };
    const logger = makeLogger();
    await expect(
      emitBugReportSafe(sink, SAMPLE_INPUT, logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
