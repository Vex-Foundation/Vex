/**
 * SessionContext tests (slice C — a11y labels + canonical selectors).
 *
 * Pins the `session-header` data selector + the labeled group for the active
 * session row. Stage 4 moved the runtime bar OUT into the BOOK panel; the
 * session-UI redesign (2026-07-29) then removed the register line itself — the
 * TITLE moved to the left rail and the Markdown EXPORT key to the status
 * strip, so this file no longer covers either. The export flow's
 * privacy-confirmation gate did not lose coverage: it moved WITH the control
 * to `SessionExportControl.test.tsx`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { SessionContext, type SessionContextProps } from "../SessionContext.js";

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

function renderCtx(overrides: Partial<SessionContextProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionContext, {
        activeSession: SESSION,
        activeSessionId: SESSION.id,
        loading: false,
        error: null,
        ...overrides,
      }),
    ),
  );
}

const exportMarkdown = vi.fn();

beforeEach(() => {
  exportMarkdown.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { sessions: { exportMarkdown } },
  });
});

describe("SessionContext header (slice C)", () => {
  it("marks the active-session row with the session-header selector + labeled group", () => {
    const { container } = renderCtx();
    const header = container.querySelector('[data-vex-area="session-header"]');
    expect(header).not.toBeNull();
    expect(header?.getAttribute("role")).toBe("group");
    // The title still NAMES the group for screen readers even though it is no
    // longer printed here — it is stated once, in the left rail.
    expect(header?.getAttribute("aria-label")).toBe("Session: Research session");
    expect(screen.queryByText("Research session")).toBeNull();
    // The export key moved to the status strip (SessionExportControl).
    expect(
      screen.queryByRole("button", { name: "Export session as Markdown" }),
    ).toBeNull();
    // S3 exception stamps: the default agent mode earns silence; only the
    // deviating `restricted` permission is stamped. (The `mission` mode stamp
    // was removed — mission identity now reads from the MISSION RAIL badge.)
    expect(screen.queryByText("agent")).toBeNull();
    expect(screen.getByText("restricted")).not.toBeNull();
    // Stage 4: the runtime bar moved to the BOOK panel — the header must NOT
    // mount it any more.
    expect(
      container.querySelector('[data-vex-area="runtime-status"]'),
    ).toBeNull();
  });

  it("renders no mission stamp and stays silent for full permission", () => {
    const { container } = renderCtx({
      activeSession: { ...SESSION, mode: "mission", permission: "full" },
    });
    expect(
      container.querySelector('[data-vex-area="session-header"]'),
    ).not.toBeNull();
    // Mission identity moved to the MISSION RAIL badge — the header no longer
    // carries a "mission" stamp, and full permission earns no chrome.
    expect(screen.queryByText("mission")).toBeNull();
    expect(screen.queryByText("restricted")).toBeNull();
  });

  it("renders the trailing slot content inside the active-session header row", () => {
    const { container } = renderCtx({
      trailing: createElement("span", { "data-testid": "trailing-slot" }, "X"),
    });
    const header = container.querySelector('[data-vex-area="session-header"]');
    expect(header).not.toBeNull();
    // The slot content lives inside the title row, not floated elsewhere.
    expect(header?.querySelector('[data-testid="trailing-slot"]')).not.toBeNull();
  });

  it("reserves no slot box when no trailing content is supplied", () => {
    const { container } = renderCtx();
    expect(
      container.querySelector('[data-testid="trailing-slot"]'),
    ).toBeNull();
    // Row still renders normally with just the exception stamp.
    expect(
      container.querySelector('[data-vex-area="session-header"]'),
    ).not.toBeNull();
  });

  it("does not render the header in the loading or not-found states", () => {
    const loading = renderCtx({ loading: true });
    expect(
      loading.container.querySelector('[data-vex-area="session-header"]'),
    ).toBeNull();
    loading.unmount();

    const notFound = renderCtx({ activeSession: null });
    expect(
      notFound.container.querySelector('[data-vex-area="session-header"]'),
    ).toBeNull();
  });

});
