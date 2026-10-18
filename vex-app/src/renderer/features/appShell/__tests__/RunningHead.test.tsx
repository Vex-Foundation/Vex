/**
 * The title bar's two cells, in every mode, and its place in the window
 * (docs/design/R3-MINIMAL.md section 3): a 44px drag row whose left cell says
 * where you are and whose right cluster holds the page keys, the Studio host
 * pill, Notices, "Needs you · N" and the token chip.
 *
 * The cells divide by WHOSE they are. `MissionRail`, `SessionExportControl`
 * and the session title are scoped to a session, and a session belongs to the
 * agent shell: `activeSessionId` survives a mode switch, so in Studio they
 * would otherwise paint a session's badge, key and name over a project
 * workspace that has nothing to do with them. Needs you is the opposite: one
 * app-wide list, visible in whichever mode the user is in. And the approvals
 * sync is mounted once, outside the cluster, in every mode. These tests assert
 * all of it rather than trusting it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ShellRoute } from "../../../stores/uiStore/shell-route.js";
import { makeError, makeHostStatus } from "../studio/__tests__/studio-fixtures.js";

const SESSION = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";

/** The Studio host status, driven directly. */
const useStudioHostStatusMock = vi.fn<
  () => Partial<UseQueryResult<Result<StudioHostStatus>>>
>();
vi.mock("../../../lib/api/studio.js", () => ({
  useStudioHostStatus: () => useStudioHostStatusMock(),
}));

const reads = vi.hoisted(() => ({
  session: null as SessionListItem | null,
  project: null as { name: string; permission: "restricted" | "full" } | null,
  needsYouCount: 3 as number | null,
}));
vi.mock("../../../lib/api/sessions.js", () => ({
  useSession: (id: string | null) => ({
    data: id === null ? undefined : { ok: true, data: reads.session },
  }),
}));
vi.mock("../../../lib/api/projects.js", () => ({
  useProject: (id: string | null) => ({
    data: id === null ? undefined : { ok: true, data: reads.project },
  }),
}));

/** The cluster's parts have their own suites; stub them so this file asserts
 * the TITLE BAR's composition, not their internals. */
vi.mock("../MissionRail.js", () => ({
  MissionRail: ({ activeSessionId }: { activeSessionId: string | null }) =>
    activeSessionId === null ? null : <div data-testid="mission-rail" />,
}));
vi.mock("../SessionExportControl.js", () => ({
  SessionExportControl: ({ activeSessionId }: { activeSessionId: string | null }) =>
    activeSessionId === null ? null : <div data-testid="export-control" />,
}));
vi.mock("../NotificationCenter.js", () => ({
  NotificationCenter: () => <div data-testid="notices" />,
}));
vi.mock("../GlobalApprovals.js", () => ({
  GlobalApprovalsSync: () => <div data-testid="approvals-sync" />,
}));
vi.mock("../../vex/NeedsYouControl.js", () => ({
  NeedsYouControl: () => <div data-testid="needs-you" />,
}));
vi.mock("../../vex/VexTokenChip.js", () => ({
  VexTokenChip: ({ open, onToggle }: { open: boolean; onToggle: () => void }) => (
    <button type="button" data-testid="token-chip" aria-pressed={open} onClick={onToggle}>
      chip
    </button>
  ),
}));
vi.mock("../../vex/useVexPresence.js", () => ({
  useNeedsYou: () => ({
    status: "ready",
    count: reads.needsYouCount,
    items: [],
    retry: () => undefined,
    retrying: false,
  }),
}));

const { RunningHead, titleBarPageOf } = await import("../RunningHead.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

type HeadProps = Parameters<typeof RunningHead>[0];

function renderHead(
  mode: "agent" | "studio" | "lighter",
  activeSessionId: string | null = null,
  extra: Partial<Pick<HeadProps, "empty" | "vex">> = {},
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
  if (head === null) throw new Error("title bar missing");
  return head;
}

function session(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: SESSION,
    mode: "agent",
    permission: "restricted",
    title: "Portfolio check",
    initialGoal: null,
    startedAt: "2026-10-17T10:00:00.000Z",
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

function title(): string | null | undefined {
  return document.querySelector("[data-vex-area='title-bar-title']")?.textContent;
}

beforeEach(() => {
  useStudioHostStatusMock.mockReset();
  useStudioHostStatusMock.mockReturnValue({
    data: { ok: true, data: makeHostStatus() },
  });
  reads.session = session();
  reads.project = { name: "vault-tools", permission: "full" };
  reads.needsYouCount = 3;
  useUiStore.setState({
    shellRoute: { kind: "none" },
    activeProjectId: null,
    runtimeMode: "agent",
    vexOpenChat: true,
    vexOpenPages: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("the left cell", () => {
  it("names the session and its mode", () => {
    renderHead("agent", SESSION);
    expect(title()).toBe("Portfolio checkAgent · Restricted");
  });

  it("names a mission session's mode and access", () => {
    reads.session = session({ mode: "mission", permission: "full" });
    renderHead("agent", SESSION);
    expect(title()).toBe("Portfolio checkMission · Full access");
  });

  it("sets the mission badge after the title", () => {
    const head = renderHead("agent", SESSION);
    const titleEl = head.querySelector("[data-vex-area='title-bar-title']");
    expect(titleEl?.parentElement?.className).toBe("vex-running-head__start");
    expect(titleEl?.nextElementSibling?.getAttribute("data-testid")).toBe("mission-rail");
  });

  it("says nothing on the welcome", () => {
    renderHead("agent", null, { empty: true });
    expect(title()).toBeUndefined();
  });

  it("names the open page, its count on Needs you, and a crumb for a subpage", () => {
    expect(titleBarPageOf({ kind: "none" })).toBeNull();
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    renderHead("agent", SESSION);
    expect(title()).toBe("Portfolio");
    cleanup();

    useUiStore.setState({ shellRoute: { kind: "needsYou", origin: null } });
    renderHead("agent", SESSION);
    expect(title()).toBe("Needs you3 decisions");
    cleanup();

    const scan: ShellRoute = { kind: "agentScan", origin: null, sessionId: null };
    expect(titleBarPageOf(scan)?.name).toBe("Agent Scan");
    expect(titleBarPageOf(scan)?.parents.map((parent) => parent.label)).toEqual(["Portfolio"]);
  });

  it("marks the Memory page read-only beside its name, as the render draws it", () => {
    useUiStore.setState({ shellRoute: { kind: "memory", origin: null } });
    renderHead("agent", SESSION);
    expect(title()).toBe("MemoryRead-only");
    expect(screen.getByText("Read-only").className).toBe("vex-tb-title__sub");
  });

  it("opens its right cluster with the slot a page's own keys land in (Portfolio's refresh)", () => {
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    const head = renderHead("agent", SESSION);
    const flank = head.querySelector(".vex-running-head__flank");
    expect(flank?.firstElementChild?.getAttribute("data-vex-area")).toBe("title-bar-page-keys");
  });

  it("names a project's register by its project, as the register's own dialog does", () => {
    reads.project = { name: "vex-core", permission: "full" };
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, sessionId: null, projectId: PROJECT },
    });
    renderHead("studio", SESSION);
    expect(title()).toBe("Portfolio/Project assets: vex-core");
    expect(screen.getByText("Project assets: vex-core").getAttribute("aria-current")).toBe("page");
    cleanup();

    // until the projects read answers it says only what kind of register it is
    reads.project = null;
    renderHead("studio", SESSION);
    expect(title()).toBe("Portfolio/Project assets");
  });

  it("draws a subpage's crumb: each parent a link up to it, the page itself current", () => {
    useUiStore.setState({
      shellRoute: {
        kind: "tokenHistory",
        origin: null,
        token: { chainId: 8453, tokenAddress: "0xabc", symbol: "USDC", tokenName: "USD Coin" },
        returnTo: { kind: "assets", sessionId: null },
      },
    });
    renderHead("agent", SESSION);
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumb.getAttribute("data-vex-area")).toBe("title-bar-title");
    expect(title()).toBe("Portfolio/All assets/USD Coin history");
    expect(screen.getByText("USD Coin history").getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "All assets" }));
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: null,
      sessionId: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Portfolio" }));
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "portfolio", origin: null });
  });

  it("names the Studio project and its access, never the agent session", () => {
    useUiStore.setState({ activeProjectId: PROJECT });
    renderHead("studio", SESSION);
    expect(title()).toBe("vault-toolsStudio · Full access");
  });
});

/**
 * Lets a deliberately malformed route reach the store's typed seam: it checks
 * only the `kind` the title cell switches on, so the rest stays as wrong as
 * the test means it to be.
 */
function hasRouteKind(value: unknown): value is ShellRoute {
  return typeof value === "object" && value !== null && "kind" in value;
}

describe("the title cell's own boundary", () => {
  it("a malformed token history route degrades the crumb and never throws", () => {
    // Built as `unknown`, then narrowed by its kind alone, never cast: the
    // route has no token and no return point on purpose.
    const malformed: unknown = { kind: "tokenHistory", origin: null };
    if (!hasRouteKind(malformed)) throw new Error("the malformed route lost its kind");
    useUiStore.setState({ shellRoute: malformed });
    renderHead("agent", SESSION);
    expect(title()).toBe("Portfolio/Token history");
  });

  it("a title that throws empties its cell and leaves the rest of the title bar standing", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      reads.session = Object.defineProperty(session(), "title", {
        get: () => {
          throw new Error("title read failed");
        },
      });
      const head = renderHead("agent", SESSION);
      expect(head.querySelector("[data-vex-title-failed]")).not.toBeNull();
      expect(title()).toBeUndefined();
      // Everything else keeps working: the approvals sync, Needs you, the chip.
      expect(screen.getByTestId("approvals-sync")).toBeTruthy();
      expect(screen.getByTestId("needs-you")).toBeTruthy();
      expect(screen.getByTestId("token-chip")).toBeTruthy();
      expect(screen.getByTestId("mission-rail")).toBeTruthy();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("the page close key", () => {
  it("is absent in agent mode, where the nav is the way back", () => {
    useUiStore.setState({ shellRoute: { kind: "settings", origin: null, section: null } });
    renderHead("agent", SESSION);
    expect(screen.queryByRole("button", { name: "Close Settings" })).toBeNull();
  });

  it("closes a top-level page in Studio, where nothing else leads back", () => {
    useUiStore.setState({ shellRoute: { kind: "settings", origin: null, section: null } });
    renderHead("studio", SESSION);
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("closes the Needs you page in Studio, the key the page itself no longer draws", () => {
    useUiStore.setState({ shellRoute: { kind: "needsYou", origin: null } });
    renderHead("studio", SESSION);
    fireEvent.click(screen.getByRole("button", { name: "Close Needs you" }));
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("is absent on a subpage, whose crumb parent is the way back", () => {
    useUiStore.setState({ shellRoute: { kind: "agentScan", origin: null, projectId: PROJECT } });
    renderHead("studio", SESSION);
    expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();
    expect(screen.getByRole("button", { name: "Portfolio" })).not.toBeNull();
  });
});

describe("the Studio host pill", () => {
  it("sits in the cluster in Studio, and nowhere else", () => {
    renderHead("studio");
    expect(screen.getByLabelText(/Vex Studio host status$/).textContent).toContain(
      "Running · 2 connected",
    );
    cleanup();
    renderHead("agent", SESSION);
    expect(screen.queryByLabelText(/Vex Studio host status$/)).toBeNull();
  });

  it("opens its card in the title bar", () => {
    useStudioHostStatusMock.mockReturnValue({
      data: { ok: true, data: makeHostStatus({ state: "locked" }) },
    });
    renderHead("studio");
    const pill = screen.getByLabelText(/Vex Studio host status$/);
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pill);
    expect(
      screen.getByRole("group", { name: "Vex Studio host status details" }).textContent,
    ).toContain("Vex is locked");
  });

  it.each([
    [makeHostStatus({ connectionCount: 0 }), "Running · 0 connected", null],
    [makeHostStatus({ connectionCount: 16, atCapacity: true }), "Running at capacity", null],
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
    renderHead("studio");
    const pill = screen.getByLabelText(/Vex Studio host status$/);
    expect(pill.textContent).toContain(word);
    if (cause !== null) {
      // The cause reaches BOTH audiences: assistive tech hears it from the
      // live region, a pointer or keyboard user reads it in the card. The head
      // also mounts the notification announcer's live regions, so the
      // assertion is over every polite region rather than "the" one.
      expect(
        screen
          .getAllByRole("status")
          .map((el) => el.textContent ?? "")
          .join(" "),
      ).toContain(cause);
      fireEvent.click(pill);
      expect(
        screen.getByRole("group", { name: "Vex Studio host status details" }).textContent,
      ).toContain(cause);
    }
  });

  it("distinguishes a read still in flight from a read that FAILED", () => {
    useStudioHostStatusMock.mockReturnValue({ data: undefined });
    renderHead("studio");
    expect(screen.getByLabelText(/Vex Studio host status$/).textContent).toContain("Checking");
    cleanup();

    useStudioHostStatusMock.mockReturnValue({
      data: { ok: false, error: makeError("nope") },
    });
    renderHead("studio");
    const pill = screen.getByLabelText(/Vex Studio host status$/);
    expect(pill.textContent).toContain("Unknown");
    fireEvent.click(pill);
    expect(
      screen.getByRole("group", { name: "Vex Studio host status details" }).textContent,
    ).toContain("Vex could not read the Studio host status.");
  });
});

describe("the right cluster", () => {
  it("keeps the spec's order: page keys, Notices, Needs you, the chip", () => {
    const head = renderHead("agent", SESSION);
    const flank = head.querySelector(".vex-running-head__flank");
    const order = Array.from(flank?.querySelectorAll("[data-testid]") ?? []).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order).toEqual(["export-control", "notices", "needs-you", "token-chip"]);
  });

  it("Needs you is present in EVERY mode, the welcome included", () => {
    const agent = renderHead("agent", SESSION);
    expect(agent.querySelector("[data-testid='needs-you']")).not.toBeNull();
    cleanup();
    const studio = renderHead("studio", SESSION);
    expect(studio.querySelector("[data-testid='needs-you']")).not.toBeNull();
    cleanup();
    const welcome = renderHead("agent", null, { empty: true });
    expect(welcome.querySelector("[data-testid='needs-you']")).not.toBeNull();
  });

  it("the session-scoped parts render nothing without a session", () => {
    renderHead("studio", null);
    expect(screen.queryByTestId("mission-rail")).toBeNull();
    expect(screen.queryByTestId("export-control")).toBeNull();
  });

  it("STUDIO gets no session parts even when a session is still selected", () => {
    // The store keeps the agent selection across a mode switch (so switching
    // back returns to it), so "no session id" is not what silences these here:
    // the title bar has to hand them null itself.
    renderHead("studio", SESSION);
    expect(screen.queryByTestId("mission-rail")).toBeNull();
    expect(screen.queryByTestId("export-control")).toBeNull();
    // ... and the app-wide list is NOT gated with them.
    expect(screen.getByTestId("needs-you")).not.toBeNull();
  });

  it("mounts the approvals sync exactly once, outside the cluster, in every mode", () => {
    for (const mode of ["agent", "studio", "lighter"] as const) {
      renderHead(mode, SESSION);
      const syncs = document.querySelectorAll("[data-testid='approvals-sync']");
      expect(syncs).toHaveLength(1);
      expect(syncs[0]?.closest(".vex-running-head__flank")).toBeNull();
      cleanup();
    }
  });
});

describe("the token chip", () => {
  it("toggles the column the frame solved", () => {
    const onToggle = vi.fn();
    renderHead("agent", SESSION, { vex: { open: false, onToggle } });
    const chip = screen.getByTestId("token-chip");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("is absent where there is no Vex column: the welcome, Zen", () => {
    const welcome = renderHead("agent", null, { empty: true });
    expect(welcome.querySelector("[data-testid='token-chip']")).toBeNull();
    cleanup();
    renderHead("lighter", SESSION, { vex: null });
    expect(screen.queryByTestId("token-chip")).toBeNull();
  });

  it("without the frame's solve, reads and writes the stored choice", () => {
    renderHead("agent", SESSION);
    const chip = screen.getByTestId("token-chip");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(useUiStore.getState().vexOpenChat).toBe(false);
  });
});

describe("the head row", () => {
  it("is the window's drag region, one 44px row", () => {
    const head = renderHead("agent", SESSION);
    expect(head.tagName).toBe("HEADER");
    expect(head.classList.contains("vex-running-head")).toBe(true);
    expect(head.classList.contains("vex-drag")).toBe(true);
  });

  it("clears its rule on the welcome stage only", () => {
    expect(renderHead("agent", null, { empty: true }).hasAttribute("data-empty")).toBe(true);
    expect(renderHead("agent", SESSION).hasAttribute("data-empty")).toBe(false);
  });

  it("has no centre word and no gutter fold any more", () => {
    const head = renderHead("agent", SESSION);
    expect(head.querySelector(".vex-running-head__centre")).toBeNull();
    expect(head.querySelector("[data-vex-running-head-fold]")).toBeNull();
    expect(head.querySelector("[data-vex-tape-state]")).toBeNull();
  });

  it("collapses in Lighter, whose top bar is its title bar", () => {
    const head = renderHead("lighter", SESSION, { empty: true });
    expect(head.className).toBe("contents");
    expect(head.hasAttribute("data-empty")).toBe(false);
    expect(head.getAttribute("data-collapsed")).toBe("true");
  });
});
