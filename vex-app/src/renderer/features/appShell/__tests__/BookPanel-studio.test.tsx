/**
 * BookPanel in STUDIO mode - the right rail's mode dispatch (B4c).
 *
 * The properties that carry the risk:
 *  1. EVERY Studio card is handed the PROJECT scope, with the selected
 *     project's id. A card that received a global or session scope would be
 *     showing the wrong wallets under a project's name - a wrong answer that
 *     renders, not a degraded one. Asserted per card, and asserted NEGATIVELY:
 *     no card in the Studio rail ever sees `global`.
 *  2. The agent-only instruments - Position, Activity, Session, Trench, and
 *     the Board tab - never mount in Studio (ratified decision 5).
 *  3. The rail reads and writes the STUDIO order key. Reordering here must not
 *     touch the agent rail's own order.
 *  4. With NO project selected, Studio shows the welcome Portfolio tab. That
 *     is the decided behaviour before any project exists, and it is the ONLY
 *     place global appears in Studio mode.
 *
 * The cards are mocked - this suite owns the router and the scope wiring, not
 * the cards' own data states (those are `WalletPairCard.test.tsx` and the
 * portfolio card suites).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";

function scopeProbe(testid: string) {
  return ({ scope }: { readonly scope: Record<string, unknown> }) => (
    <div
      data-testid={testid}
      data-scope-kind={String(scope["kind"])}
      data-project-id={String(scope["projectId"] ?? "")}
    />
  );
}

vi.mock("../book/portfolio/PortfolioOverviewCard.js", () => ({
  PortfolioOverviewCard: scopeProbe("card-overview"),
}));
vi.mock("../book/portfolio/BalancesCard.js", () => ({
  BalancesCard: scopeProbe("card-balances"),
}));
vi.mock("../book/WalletPairCard.js", () => ({
  WalletPairCard: scopeProbe("card-wallets"),
}));
vi.mock("../book/PositionBlock.js", () => ({
  PositionBlock: () => <div data-testid="card-position" />,
}));
vi.mock("../book/SessionActivityCard.js", () => ({
  SessionActivityCard: () => <div data-testid="card-activity" />,
}));
vi.mock("../book/SessionBlock.js", () => ({
  SessionBlock: () => <div data-testid="card-session" />,
}));
vi.mock("../book/ImageLockerCard.js", () => ({
  ImageLockerCard: () => <div data-testid="card-images" />,
}));
vi.mock("../book/board/ActiveBoardModule.js", () => ({
  ActiveBoardModule: () => <div data-testid="board-module" />,
}));
vi.mock("../book/portfolio/WelcomePortfolioPanel.js", () => ({
  WelcomePortfolioPanel: ({ bookOpen }: { readonly bookOpen: boolean }) => (
    <div
      data-testid="welcome-portfolio-panel"
      data-book-open={bookOpen ? "true" : "false"}
    />
  ),
}));

const { BookPanel } = await import("../BookPanel.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const PROJECT = "9c1b0e8e-0000-4000-8000-0000000000ab";
const SESSION = "44444444-4444-4444-8444-444444444444";

/**
 * The projects read the STUDIO rail's header makes, stubbed at the bridge.
 *
 * The Studio header names itself with the OPEN PROJECT'S name, which is a
 * domain read and therefore goes through the repository's async-data layer
 * (`useProjects`) like every other one. Production mounts the whole shell under
 * the app's `QueryClientProvider` (`main.tsx`), so this harness supplies the
 * same provider rather than mocking the hook away: a rail that reads its own
 * name is the behaviour under test, and a mocked hook would prove the router
 * against a shell the app never renders.
 */
const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();

function mountStudio(projectId: string | null, activeSessionId: string | null = null) {
  // Only the MODE selection - the beforeEach owns the order defaults, so a
  // test that seeds an order is not silently reset here.
  useUiStore.setState({ runtimeMode: "studio", activeProjectId: projectId });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BookPanel
        activeSessionId={activeSessionId}
        bookOpen
        onToggle={() => undefined}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  projectsListMock.mockReset();
  projectsListMock.mockResolvedValue({ ok: true, data: [] });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { projects: { list: projectsListMock } },
  });
  useUiStore.setState({
    runtimeMode: "agent",
    activeProjectId: null,
    bookSectionOrder: [],
    studioBookSectionOrder: [],
    bookTab: "portfolio",
  });
});

describe("Studio rail - the project scope reaches every card", () => {
  it("renders the ratified stack in order, all on the PROJECT scope", () => {
    mountStudio(PROJECT);
    const rendered = Array.from(
      document.querySelectorAll("[data-vex-book-section]"),
    ).map((node) => node.getAttribute("data-vex-book-section"));
    expect(rendered).toEqual(["portfolio", "wallets", "balances"]);

    for (const testid of ["card-overview", "card-wallets", "card-balances"]) {
      const card = screen.getByTestId(testid);
      expect(card.getAttribute("data-scope-kind")).toBe("project");
      expect(card.getAttribute("data-project-id")).toBe(PROJECT);
    }
  });

  it("NEVER hands a card the global scope, even with no session open", () => {
    mountStudio(PROJECT, null);
    const kinds = Array.from(
      document.querySelectorAll("[data-scope-kind]"),
    ).map((node) => node.getAttribute("data-scope-kind"));
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain("global");
    expect(kinds).not.toContain("session");
  });

  it("ignores a leftover agent session - the scope follows the PROJECT", () => {
    // The agent session id survives a mode switch (it is not cleared), and it
    // must not leak into a Studio card's read.
    mountStudio(PROJECT, SESSION);
    expect(screen.getByTestId("card-balances").getAttribute("data-scope-kind")).toBe(
      "project",
    );
  });
});

describe("Studio rail - the agent instruments are absent", () => {
  it("mounts no Position, Activity, Session or Trench card", () => {
    mountStudio(PROJECT);
    for (const testid of [
      "card-position",
      "card-activity",
      "card-session",
      "card-images",
    ]) {
      expect(screen.queryByTestId(testid)).toBeNull();
    }
  });

  it("offers no Board tab at all", () => {
    mountStudio(PROJECT);
    expect(screen.queryByRole("tab", { name: /board/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /portfolio/i })).toBeNull();
    expect(screen.queryByTestId("board-module")).toBeNull();
  });

  it("names the rail for what it is instrumenting", () => {
    mountStudio(PROJECT);
    expect(screen.getByLabelText("Project instrument")).not.toBeNull();
  });

  it("heads the rail with the OPEN PROJECT'S name, with the build stamp at the foot", async () => {
    // A3. The one line above a user's wallets used to be the app version,
    // which names the build rather than the thing the numbers belong to. The
    // version is not gone - it moved to the foot, where a build stamp belongs -
    // so this asserts both halves, in order, on one rail.
    const { makeProject } = await import("../studio/__tests__/studio-fixtures.js");
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ id: PROJECT, name: "vex-core" })],
    });
    mountStudio(PROJECT);

    const rail = screen.getByLabelText("Project instrument");
    await waitFor(() => {
      expect(rail.textContent).toContain("vex-core");
    });

    // DOM order is the reading order: the name heads the rail, the stamp floors
    // it. Reading both out of ONE ordered walk says which comes first without
    // depending on the class names either one happens to carry.
    const spans = Array.from(rail.querySelectorAll("span"));
    const nameAt = spans.findIndex((node) => node.textContent === "vex-core");
    const stampAt = spans.findIndex((node) => /^v\d/.test(node.textContent ?? ""));
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(stampAt).toBeGreaterThan(nameAt);
  });

  it("shows NO headline while the projects read is still in flight", () => {
    // A name is a claim about which project these numbers belong to. Until the
    // read answers there is no confirmed project, so the header carries no
    // headline rather than a placeholder standing in for one.
    projectsListMock.mockReturnValue(new Promise(() => undefined));
    mountStudio(PROJECT);
    const rail = screen.getByLabelText("Project instrument");
    expect(rail.textContent).not.toContain("vex-core");
  });
});

describe("Studio rail - its own persisted order", () => {
  it("renders the RESOLVED stored order, not the default", () => {
    useUiStore.setState({ studioBookSectionOrder: ["balances"] });
    mountStudio(PROJECT);
    const rendered = Array.from(
      document.querySelectorAll("[data-vex-book-section]"),
    ).map((node) => node.getAttribute("data-vex-book-section"));
    // Missing ids are appended at the end, never guessed into a default slot.
    expect(rendered).toEqual(["balances", "portfolio", "wallets"]);
  });

  it("a keyboard reorder writes the STUDIO key and leaves the agent order alone", () => {
    useUiStore.setState({ bookSectionOrder: ["trench", "wallets"] });
    mountStudio(PROJECT);
    const handle = screen.getByRole("button", {
      name: /Reorder Portfolio Overview - position 1 of 3/,
    });
    fireEvent.keyDown(handle, { key: "ArrowDown" });

    expect([...useUiStore.getState().studioBookSectionOrder]).toEqual([
      "wallets",
      "portfolio",
      "balances",
    ]);
    expect([...useUiStore.getState().bookSectionOrder]).toEqual([
      "trench",
      "wallets",
    ]);
  });
});

describe("Studio rail - before any project is selected", () => {
  it("shows the welcome Portfolio tab, carrying the shared bookOpen flag", () => {
    mountStudio(null);
    const panel = screen.getByTestId("welcome-portfolio-panel");
    expect(panel.getAttribute("data-book-open")).toBe("true");
    expect(screen.queryByTestId("card-overview")).toBeNull();
  });
});

describe("agent mode is untouched", () => {
  it("still renders the session rail with its own instruments", () => {
    useUiStore.setState({ runtimeMode: "agent", activeProjectId: PROJECT });
    render(
      <BookPanel activeSessionId={SESSION} bookOpen onToggle={() => undefined} />,
    );
    expect(screen.getByLabelText("Session instrument")).not.toBeNull();
    expect(screen.getByTestId("card-position")).not.toBeNull();
    expect(screen.getByTestId("card-balances").getAttribute("data-scope-kind")).toBe(
      "session",
    );
  });
});
