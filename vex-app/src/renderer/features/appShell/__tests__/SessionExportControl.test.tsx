/**
 * SessionExportControl tests — the Markdown export key on the status strip.
 *
 * This coverage MOVED here verbatim with the control when the session-UI
 * redesign (2026-07-29) retired the register line it used to sit on
 * (`SessionContext`). The contract it protects is a privacy gate, not chrome:
 * a click must NEVER export on its own — it opens the confirmation dialog, and
 * only an explicit confirm fires the mutation. A native-dialog cancellation
 * afterwards stays silent.
 *
 * The control resolves the session itself through `useSession`, so the session
 * query is mocked here rather than passed as a prop.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionListItem } from "@shared/schemas/sessions.js";

const SESSION: SessionListItem = {
  id: "00000000-0000-4000-8000-0000000000e1",
  mode: "agent",
  permission: "restricted",
  title: "Research session",
  initialGoal: null,
  startedAt: "2026-05-26T10:00:00.000Z",
  endedAt: null,
  missionStatus: null,
  pinnedAt: null,
};

// Only the session lookup is stubbed; the export mutation stays REAL so the
// confirm→mutate ordering below is the production path, driven through the
// mocked `window.vex.sessions.exportMarkdown` bridge.
vi.mock("../../../lib/api/sessions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/api/sessions.js")>();
  return {
    ...actual,
    useSession: () => ({ data: { ok: true, data: SESSION } }),
  };
});

const { SessionExportControl } = await import("../SessionExportControl.js");

const exportMarkdown = vi.fn();

beforeEach(() => {
  exportMarkdown.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { sessions: { exportMarkdown } },
  });
});

function renderControl() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionExportControl, { activeSessionId: SESSION.id }),
    ),
  );
}

describe("SessionExportControl", () => {
  it("requires confirmation before exporting and announces a successful save", async () => {
    exportMarkdown.mockResolvedValue({ ok: true, data: { outcome: "saved" } });
    renderControl();

    fireEvent.click(
      screen.getByRole("button", { name: "Export session as Markdown" }),
    );
    // Privacy-contract confirmation gate: nothing exported yet.
    expect(exportMarkdown).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Export session as Markdown?"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(exportMarkdown).toHaveBeenCalledWith({ id: SESSION.id }),
    );
    expect(await screen.findByText("Exported")).not.toBeNull();
  });

  it("keeps native-dialog cancellation silent after confirming", async () => {
    exportMarkdown.mockResolvedValue({
      ok: true,
      data: { outcome: "cancelled" },
    });
    renderControl();

    fireEvent.click(
      screen.getByRole("button", { name: "Export session as Markdown" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));

    await waitFor(() => expect(exportMarkdown).toHaveBeenCalledOnce());
    expect(screen.queryByText("Exported")).toBeNull();
    expect(screen.queryByText("Export failed")).toBeNull();
  });

  it("lets the user cancel the confirmation dialog without exporting", () => {
    renderControl();

    fireEvent.click(
      screen.getByRole("button", { name: "Export session as Markdown" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(exportMarkdown).not.toHaveBeenCalled();
    // The shared Dialog keeps children mounted and closes via the native
    // <dialog> `open` attribute (see ReportIssueDialog.test.tsx) — assert
    // closure through the attribute, not text presence.
    expect(document.querySelector("dialog[open]")).toBeNull();
  });
});
