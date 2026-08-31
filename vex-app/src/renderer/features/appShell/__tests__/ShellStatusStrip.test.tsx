/**
 * The strip's three zones, in both modes.
 *
 * The centre word is the thing that changes with the mode; the flanks are the
 * things that must NOT be forked. `MissionRail` and `SessionExportControl` are
 * session-scoped and already render nothing without a resolved session, so
 * Studio mode gets an empty left flank for free - these tests assert that
 * rather than trusting it, because "it already returns null" is exactly the
 * kind of claim that stops being true silently.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import type { UseQueryResult } from "@tanstack/react-query";
import { makeError, makeHostStatus } from "../studio/__tests__/studio-fixtures.js";

/** The strip's only mode-dependent input, driven directly. */
const useStudioHostStatusMock = vi.fn<
  () => Partial<UseQueryResult<Result<StudioHostStatus>>>
>();
vi.mock("../../../lib/api/studio.js", () => ({
  useStudioHostStatus: () => useStudioHostStatusMock(),
}));

/** The flanks and the approvals cluster have their own suites; stub them here
 * so this file asserts the STRIP's composition, not their internals. */
vi.mock("../MissionRail.js", () => ({
  MissionRail: ({ activeSessionId }: { activeSessionId: string | null }) =>
    activeSessionId === null ? null : <div data-testid="mission-rail" />,
}));
vi.mock("../SessionExportControl.js", () => ({
  SessionExportControl: ({ activeSessionId }: { activeSessionId: string | null }) =>
    activeSessionId === null ? null : <div data-testid="export-control" />,
}));
vi.mock("../GlobalErrorBanner.js", () => ({ GlobalErrorBanner: () => null }));
vi.mock("../GlobalApprovals.js", () => ({
  GlobalApprovals: () => <div data-testid="approvals-badge" />,
}));
vi.mock("../DeskRuleTapeState.js", () => ({
  DeskRuleTapeState: () => <span data-testid="desk-rule-word">Idle</span>,
}));

const { ShellStatusStrip } = await import("../ShellStatusStrip.js");

function renderStrip(
  mode: "agent" | "studio",
  activeSessionId: string | null = null,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ShellStatusStrip runtimeMode={mode} activeSessionId={activeSessionId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useStudioHostStatusMock.mockReset();
  useStudioHostStatusMock.mockReturnValue({
    data: { ok: true, data: makeHostStatus() },
  });
});

describe("the centre word", () => {
  it("agent mode takes it from DeskRuleTapeState", () => {
    renderStrip("agent");
    expect(screen.getByTestId("desk-rule-word")).not.toBeNull();
    expect(screen.queryByLabelText("Vex Studio host status")).toBeNull();
  });

  it("studio mode takes it from the host status", () => {
    renderStrip("studio");
    expect(screen.queryByTestId("desk-rule-word")).toBeNull();
    expect(screen.getByLabelText("Vex Studio host status").textContent).toContain(
      "Running 2 connected",
    );
  });

  it.each([
    [makeHostStatus({ connectionCount: 0 }), "Running 0 connected", null],
    [
      makeHostStatus({ connectionCount: 16, atCapacity: true }),
      "Running at capacity",
      null,
    ],
    [makeHostStatus({ state: "locked" }), "Locked", null],
    [makeHostStatus({ state: "starting" }), "Starting", null],
    [
      makeHostStatus({ state: "unavailable", cause: "starting" }),
      "Unavailable",
      "Vex Studio is still starting up.",
    ],
    [
      makeHostStatus({ state: "unavailable", cause: "fence_uninitialized" }),
      "Unavailable",
      "Vex Studio cannot accept approvals yet, so it is not serving calls.",
    ],
    [
      makeHostStatus({ state: "unavailable", cause: "shutting_down" }),
      "Unavailable",
      "Vex is shutting down, so Studio has stopped serving calls.",
    ],
    [
      makeHostStatus({ state: "unavailable", cause: "not_configured" }),
      "Unavailable",
      "No agent executor is installed, so Vex Studio has nothing to serve.",
    ],
    [
      makeHostStatus({ state: "unavailable", cause: "endpoint_unavailable" }),
      "Unavailable",
      "Vex Studio could not open its local endpoint on this machine.",
    ],
  ])("renders %o as its word and cause", (status, word, cause) => {
    useStudioHostStatusMock.mockReturnValue({ data: { ok: true, data: status } });
    renderStrip("studio");
    const el = screen.getByLabelText("Vex Studio host status");
    expect(el.textContent).toContain(word);
    if (cause === null) {
      expect(el.getAttribute("title")).toBeNull();
    } else {
      // The cause reaches BOTH audiences: a pointer user through the title and
      // assistive tech through the visually-hidden span. A bare "Unavailable"
      // is the "unexpected error" the product rules forbid.
      expect(el.getAttribute("title")).toBe(cause);
      expect(el.textContent).toContain(cause);
    }
  });

  it("distinguishes a read still in flight from a read that FAILED", () => {
    useStudioHostStatusMock.mockReturnValue({ data: undefined });
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ShellStatusStrip runtimeMode="studio" activeSessionId={null} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Vex Studio host status").textContent).toContain(
      "Checking",
    );
    unmount();

    useStudioHostStatusMock.mockReturnValue({
      data: { ok: false, error: makeError("nope") },
    });
    renderStrip("studio");
    const el = screen.getByLabelText("Vex Studio host status");
    expect(el.textContent).toContain("Unknown");
    expect(el.getAttribute("title")).toBe(
      "Vex could not read the Studio host status.",
    );
  });
});

describe("the flanks", () => {
  it("the approvals badge is present in BOTH modes", () => {
    renderStrip("agent");
    expect(screen.getByTestId("approvals-badge")).not.toBeNull();
    screen.getByTestId("approvals-badge").remove();
    renderStrip("studio");
    expect(screen.getByTestId("approvals-badge")).not.toBeNull();
  });

  it("the session-scoped flanks render nothing without a session", () => {
    renderStrip("studio", null);
    expect(screen.queryByTestId("mission-rail")).toBeNull();
    expect(screen.queryByTestId("export-control")).toBeNull();
  });

  it("the session-scoped flanks render WITH a session, unforked by mode", () => {
    renderStrip("agent", "44444444-4444-4444-8444-444444444444");
    expect(screen.getByTestId("mission-rail")).not.toBeNull();
    expect(screen.getByTestId("export-control")).not.toBeNull();
  });
});
