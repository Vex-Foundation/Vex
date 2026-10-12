/**
 * The running head's three zones, in every mode, and its place in the window
 * (docs/design/V10-SPREAD.md sections 4 and 8): a 44px drag row whose rule
 * clears on the welcome stage and whose left cell carries the folded gutter.
 *
 * The centre word is the thing that changes with the mode, and the flanks
 * divide by WHOSE they are. `MissionRail` and `SessionExportControl` are scoped
 * to a session, and a session belongs to the agent shell: `activeSessionId`
 * survives a mode switch, so in Studio both would otherwise paint a mission
 * badge and an export key over a project workspace that has nothing to do with
 * them. The approvals cluster is the opposite - one app-wide queue, visible in
 * whichever mode the user is in. These tests assert both rather than trusting
 * them.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import type { UseQueryResult } from "@tanstack/react-query";
import { makeError, makeHostStatus } from "../studio/__tests__/studio-fixtures.js";

/** The head's only mode-dependent input, driven directly. */
const useStudioHostStatusMock = vi.fn<
  () => Partial<UseQueryResult<Result<StudioHostStatus>>>
>();
vi.mock("../../../lib/api/studio.js", () => ({
  useStudioHostStatus: () => useStudioHostStatusMock(),
}));

/** The flanks and the approvals cluster have their own suites; stub them here
 * so this file asserts the HEAD's composition, not their internals. */
vi.mock("../MissionRail.js", () => ({
  MissionRail: ({ activeSessionId }: { activeSessionId: string | null }) =>
    activeSessionId === null ? null : <div data-testid="mission-rail" />,
}));
vi.mock("../SessionExportControl.js", () => ({
  SessionExportControl: ({ activeSessionId }: { activeSessionId: string | null }) =>
    activeSessionId === null ? null : <div data-testid="export-control" />,
}));
vi.mock("../GlobalApprovals.js", () => ({
  GlobalApprovals: () => <div data-testid="approvals-badge" />,
}));
vi.mock("../DeskRuleTapeState.js", () => ({
  DeskRuleTapeState: () => <span data-testid="desk-rule-word">Idle</span>,
}));

const { RunningHead } = await import("../RunningHead.js");

function renderStrip(
  mode: "agent" | "studio" | "lighter",
  activeSessionId: string | null = null,
  extra: { readonly fold?: ReactNode; readonly empty?: boolean } = {},
): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RunningHead runtimeMode={mode} activeSessionId={activeSessionId} {...extra} />
    </QueryClientProvider>,
  );
  const head = view.container.querySelector<HTMLElement>("[data-vex-area='shell-status-strip']");
  if (head === null) throw new Error("running head missing");
  return head;
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
    expect(screen.queryByLabelText(/Vex Studio host status$/)).toBeNull();
  });

  it("lighter mode shows no word: the desk carries its own feed status", () => {
    renderStrip("lighter", "session-1");
    expect(screen.queryByTestId("desk-rule-word")).toBeNull();
    expect(screen.queryByLabelText(/Vex Studio host status$/)).toBeNull();
  });

  it("studio mode takes it from the host status", () => {
    renderStrip("studio");
    expect(screen.queryByTestId("desk-rule-word")).toBeNull();
    expect(screen.getByLabelText(/Vex Studio host status$/).textContent).toContain(
      "Running 2 connected",
    );
  });

  it("the word is the PILL, and the pill opens its card in the head", () => {
    // The audit's finding I7: the word sat alone with no sentence and no
    // action. The head's job here is only that the control it mounts is the
    // pill; the card's per-cause contents are `StudioHostStatusPill.test.tsx`.
    useStudioHostStatusMock.mockReturnValue({
      data: { ok: true, data: makeHostStatus({ state: "locked" }) },
    });
    renderStrip("studio");
    const pill = screen.getByLabelText(/Vex Studio host status$/);
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pill);
    expect(
      screen.getByRole("group", { name: "Vex Studio host status details" })
        .textContent,
    ).toContain("Vex is locked");
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
    const pill = screen.getByLabelText(/Vex Studio host status$/);
    expect(pill.textContent).toContain(word);
    if (cause !== null) {
      // The cause reaches BOTH audiences, which is what the bare word never
      // did: assistive tech hears it from the live region without touching
      // anything, and a pointer or keyboard user reads it in the card.
      // The head also mounts the notification announcer's live regions, so
      // the assertion is over every polite region rather than "the" one.
      expect(
        screen
          .getAllByRole("status")
          .map((el) => el.textContent ?? "")
          .join(" "),
      ).toContain(cause);
      fireEvent.click(pill);
      expect(
        screen.getByRole("group", { name: "Vex Studio host status details" })
          .textContent,
      ).toContain(cause);
    }
  });

  it("distinguishes a read still in flight from a read that FAILED", () => {
    useStudioHostStatusMock.mockReturnValue({ data: undefined });
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <RunningHead runtimeMode="studio" activeSessionId={null} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText(/Vex Studio host status$/).textContent).toContain(
      "Checking",
    );
    unmount();

    useStudioHostStatusMock.mockReturnValue({
      data: { ok: false, error: makeError("nope") },
    });
    renderStrip("studio");
    const pill = screen.getByLabelText(/Vex Studio host status$/);
    expect(pill.textContent).toContain("Unknown");
    fireEvent.click(pill);
    expect(
      screen.getByRole("group", { name: "Vex Studio host status details" })
        .textContent,
    ).toContain("Vex could not read the Studio host status.");
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

  it("the session-scoped flanks render WITH a session in agent mode", () => {
    renderStrip("agent", "44444444-4444-4444-8444-444444444444");
    expect(screen.getByTestId("mission-rail")).not.toBeNull();
    expect(screen.getByTestId("export-control")).not.toBeNull();
  });

  it("STUDIO gets no session flanks even when a session is still selected", () => {
    // The store keeps the agent selection across a mode switch (so switching
    // back returns to it), so "no session id" is not what silences these here
    // - the head has to hand them null itself.
    renderStrip("studio", "44444444-4444-4444-8444-444444444444");
    expect(screen.queryByTestId("mission-rail")).toBeNull();
    expect(screen.queryByTestId("export-control")).toBeNull();
    // ... and the app-wide cluster is NOT gated with them.
    expect(screen.getByTestId("approvals-badge")).not.toBeNull();
  });
});

describe("the head row", () => {
  it("is the window's drag region, one 44px row", () => {
    const head = renderStrip("agent", "44444444-4444-4444-8444-444444444444");
    expect(head.tagName).toBe("HEADER");
    expect(head.classList.contains("vex-running-head")).toBe(true);
    expect(head.classList.contains("vex-drag")).toBe(true);
  });

  it("clears its rule on the welcome stage only", () => {
    expect(renderStrip("agent", null, { empty: true }).hasAttribute("data-empty")).toBe(true);
    expect(
      renderStrip("agent", "44444444-4444-4444-8444-444444444444").hasAttribute("data-empty"),
    ).toBe(false);
  });

  it("carries the folded gutter in its left cell, before the mission rail", () => {
    const head = renderStrip("agent", "44444444-4444-4444-8444-444444444444", {
      fold: <span data-testid="fold" />,
    });
    const fold = head.querySelector("[data-testid='fold']");
    expect(fold?.parentElement?.className).toBe("vex-running-head__start");
    expect(fold?.nextElementSibling?.getAttribute("data-testid")).toBe("mission-rail");
  });

  it("shows no fold while the gutter is open", () => {
    const head = renderStrip("agent", "44444444-4444-4444-8444-444444444444");
    expect(head.querySelector("[data-vex-running-head-fold]")).toBeNull();
  });

  it("collapses in Lighter, whose top bar is its running head", () => {
    const head = renderStrip("lighter", "session-1", { empty: true });
    expect(head.className).toBe("contents");
    expect(head.hasAttribute("data-empty")).toBe(false);
    expect(head.getAttribute("data-collapsed")).toBe("true");
  });
});
