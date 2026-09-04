/**
 * Renderer-side tests for the ReportIssueDialog form.
 *
 * Mocks `window.vex.support.createBugReport` (per vex-testing-quality-gates §3 —
 * never mock ipcRenderer in renderer tests).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const createBugReportMock = vi.fn();

beforeEach(() => {
  createBugReportMock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      support: {
        createBugReport: createBugReportMock,
      },
    },
  });
});

const { ReportIssueDialog } = await import("../ReportIssueDialog.js");

function renderOpen(): { onOpenChange: ReturnType<typeof vi.fn> } {
  const onOpenChange = vi.fn();
  render(<ReportIssueDialog open={true} onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe("ReportIssueDialog", () => {
  it("submits a manual user_reported_bug with default severity", async () => {
    createBugReportMock.mockResolvedValueOnce({
      ok: true,
      data: {
        reportId: "00000000-0000-0000-0000-000000000000",
        recorded: true,
        uploadState: "not_configured",
      },
    });
    const { onOpenChange } = renderOpen();

    const titleInput = screen.getByLabelText(/Title/i);
    fireEvent.change(titleInput, { target: { value: "Something broke" } });

    const submit = screen.getByRole("button", { name: /Save report/i });
    fireEvent.click(submit);

    await waitFor(() => expect(createBugReportMock).toHaveBeenCalledTimes(1));
    const arg = createBugReportMock.mock.calls[0]?.[0] as {
      reportKind: string;
      source: string;
      category: string;
      severity: string;
      title: string;
    };
    expect(arg.reportKind).toBe("manual");
    expect(arg.source).toBe("user");
    expect(arg.category).toBe("user_reported_bug");
    expect(arg.severity).toBe("error");
    expect(arg.title).toBe("Something broke");

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/saved locally/i),
    );
    await waitFor(
      () => expect(onOpenChange).toHaveBeenCalledWith(false),
      { timeout: 1500 },
    );
  });

  it("surfaces a persistence error from the IPC", async () => {
    createBugReportMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "support.persist_failed",
        domain: "support",
        message: "Could not record the bug report locally.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });
    renderOpen();
    fireEvent.change(screen.getByLabelText(/Title/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save report/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /Could not record/i,
      ),
    );
  });

  it("disables submit on empty title", () => {
    renderOpen();
    const submit = screen.getByRole("button", {
      name: /Save report/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
