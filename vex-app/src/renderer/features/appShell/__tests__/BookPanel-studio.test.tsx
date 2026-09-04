/**
 * BookPanel in STUDIO mode - the project rail IS the session rail (owner
 * parity decree, screenshots 2026-09-04).
 *
 * The properties that carry the risk:
 *  1. PARITY. The Studio rail renders the SAME sections, in the same order,
 *     under the same labels, from the same registry - minus exactly the
 *     sections `BOOK_SECTION_SCOPES` says have no project-scoped read. The
 *     table below is written by hand and BOTH the registry and the rendered
 *     DOM are held to it, in both rails, so a card that quietly appears on one
 *     rail only fails here.
 *  2. EVERY Studio card is handed the PROJECT scope, with the selected
 *     project's id. A card that received a global or session scope would be
 *     showing the wrong wallets under a project's name - a wrong answer that
 *     renders, not a degraded one. Asserted per card, and asserted NEGATIVELY:
 *     no card in the Studio rail ever sees `global` or `session`.
 *  3. NO SESSION ASSUMPTION LEAKS. A project with no agent session open
 *     renders every one of its sections; a leftover session id never reaches a
 *     project card.
 *  4. The Portfolio/Board toggle is the same toggle, on the same persisted
 *     preference, in both rails.
 *  5. The rail reads and writes the STUDIO order key. Reordering here must not
 *     touch the agent rail's own order.
 *  6. With NO project selected, Studio shows the welcome Portfolio tab. That
 *     is the decided behaviour before any project exists, and it is the ONLY
 *     place global appears in Studio mode.
 *
 * The cards are mocked - this suite owns the rail and the scope wiring, not
 * the cards' own data states (those are `WalletPairCard.test.tsx`,
 * `PositionBlock.test.tsx` and the portfolio card suites).
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
      data-session-id={String(scope["sessionId"] ?? "")}
    />
  );
}

/** A session-only card: its probe records the id it was handed. */
function sessionProbe(testid: string) {
  return ({ sessionId }: { readonly sessionId: string }) => (
    <div data-testid={testid} data-session-id={sessionId} />
  );
}

vi.mock("../book/portfolio/BalancesCard.js", () => ({
  BalancesCard: scopeProbe("card-balances"),
}));
vi.mock("../book/WalletPairCard.js", () => ({
  WalletPairCard: scopeProbe("card-wallets"),
}));
vi.mock("../book/PositionBlock.js", () => ({
  PositionBlock: scopeProbe("card-position"),
}));
vi.mock("../book/SessionActivityCard.js", () => ({
  SessionActivityCard: scopeProbe("card-activity"),
}));
vi.mock("../book/SessionBlock.js", () => ({
  SessionBlock: sessionProbe("card-session"),
}));
vi.mock("../book/ImageLockerCard.js", () => ({
  ImageLockerCard: sessionProbe("card-images"),
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
const { BOOK_SECTION_LABEL, DEFAULT_BOOK_SECTIONS } = await import(
  "../book/section-order.js"
);
const { DEFAULT_STUDIO_BOOK_SECTIONS } = await import(
  "../book/studio-section-order.js"
);

const PROJECT = "9c1b0e8e-0000-4000-8000-0000000000ab";
const SESSION = "44444444-4444-4444-8444-444444444444";

/**
 * THE PARITY TABLE - the contract, written out by hand rather than derived
 * from the code it checks.
 *
 * `studio: false` is never a taste decision about what a project rail "should"
 * show; it is a card that has no honest project-scoped read, and the reason
 * says which one is missing. When that read lands, this table gains a `true`
 * and the registry has to follow.
 */
const PARITY = [
  { id: "position", label: "Position", testid: "card-position", studio: true },
  { id: "wallets", label: "Wallets", testid: "card-wallets", studio: true },
  { id: "balances", label: "Balances", testid: "card-balances", studio: true },
  {
    id: "activity",
    label: "Activity",
    testid: "card-activity",
    // TURNED TRUE by the project-scoped Agent Scan read (2026-09-04):
    // `agentScanFiltersSchema` carries `filters.projectId`, and main resolves
    // that project's own wallets from `project_wallets` and intersects them
    // with the inventory allow-list (`agent-scan-db.ts`). The read is real, so
    // the row is `true` and the registry has to follow - which is exactly the
    // direction this table's doc says it moves in.
    studio: true,
  },
  {
    id: "session",
    label: "Session",
    testid: "card-session",
    studio: false,
    why: "the card IS the session object",
  },
  {
    id: "trench",
    label: "Trench Express",
    testid: "card-images",
    studio: false,
    why: "the image locker is keyed by session id in main",
  },
] as const;

const STUDIO_ROWS = PARITY.filter((row) => row.studio);
const SESSION_ONLY_ROWS = PARITY.filter((row) => !row.studio);

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();

function renderedSectionIds(): readonly (string | null)[] {
  return Array.from(document.querySelectorAll("[data-vex-book-section]")).map(
    (node) => node.getAttribute("data-vex-book-section"),
  );
}

function mountPanel(activeSessionId: string | null) {
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

/**
 * The Studio rail. Production mounts the whole shell under the app's
 * `QueryClientProvider` (`main.tsx`), so this harness supplies the same
 * provider rather than mocking the project reads away: a rail that reads its
 * own name and its own wallet selection is the behaviour under test.
 */
function mountStudio(
  projectId: string | null,
  activeSessionId: string | null = null,
) {
  // Only the MODE selection - the beforeEach owns the order defaults, so a
  // test that seeds an order is not silently reset here.
  useUiStore.setState({ runtimeMode: "studio", activeProjectId: projectId });
  return mountPanel(activeSessionId);
}

function mountAgent(activeSessionId: string) {
  useUiStore.setState({ runtimeMode: "agent", activeProjectId: PROJECT });
  return mountPanel(activeSessionId);
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

describe("the parity table is the registry", () => {
  it("the agent rail is exactly the table, in table order", () => {
    expect([...DEFAULT_BOOK_SECTIONS]).toEqual(PARITY.map((row) => row.id));
  });

  it("the Studio rail is exactly the project-capable rows, in the same order", () => {
    expect([...DEFAULT_STUDIO_BOOK_SECTIONS]).toEqual(
      STUDIO_ROWS.map((row) => row.id),
    );
  });

  it("one label table serves both rails - a card is never called two names", () => {
    for (const row of PARITY) {
      expect(BOOK_SECTION_LABEL[row.id]).toBe(row.label);
    }
  });
});

describe("the two rails render the same sections for the same table", () => {
  it("the agent rail renders every row", () => {
    mountAgent(SESSION);
    expect(renderedSectionIds()).toEqual(PARITY.map((row) => row.id));
    for (const row of PARITY) {
      expect(screen.getByTestId(row.testid)).not.toBeNull();
    }
  });

  it("the Studio rail renders every project-capable row and no other", () => {
    mountStudio(PROJECT);
    expect(renderedSectionIds()).toEqual(STUDIO_ROWS.map((row) => row.id));
    for (const row of STUDIO_ROWS) {
      expect(screen.getByTestId(row.testid)).not.toBeNull();
    }
    for (const row of SESSION_ONLY_ROWS) {
      expect(screen.queryByTestId(row.testid)).toBeNull();
    }
  });

  it("the drag handles wear the SAME labels on both rails", () => {
    mountStudio(PROJECT);
    for (const [index, row] of STUDIO_ROWS.entries()) {
      const name = new RegExp(
        `Reorder ${row.label} - position ${index + 1} of ${STUDIO_ROWS.length}`,
      );
      expect(screen.getByRole("button", { name })).not.toBeNull();
    }
  });
});

describe("Studio rail - the project scope reaches every card", () => {
  it("hands every card the PROJECT scope with the selected project's id", () => {
    mountStudio(PROJECT);
    for (const row of STUDIO_ROWS) {
      const card = screen.getByTestId(row.testid);
      expect(card.getAttribute("data-scope-kind")).toBe("project");
      expect(card.getAttribute("data-project-id")).toBe(PROJECT);
    }
  });

  it("NEVER hands a card the global or session scope, with no session open", () => {
    mountStudio(PROJECT, null);
    const kinds = Array.from(document.querySelectorAll("[data-scope-kind]")).map(
      (node) => node.getAttribute("data-scope-kind"),
    );
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain("global");
    expect(kinds).not.toContain("session");
  });

  it("a project with NO session still renders every one of its sections", () => {
    // The session-only assumption a shared rail could leak: a rail that needed
    // a session id would render short, or not at all, without one.
    mountStudio(PROJECT, null);
    expect(renderedSectionIds()).toEqual(STUDIO_ROWS.map((row) => row.id));
  });

  it("ignores a leftover agent session - the scope follows the PROJECT", () => {
    // The agent session id survives a mode switch (it is not cleared), and it
    // must not leak into a Studio card's read.
    mountStudio(PROJECT, SESSION);
    for (const row of STUDIO_ROWS) {
      const card = screen.getByTestId(row.testid);
      expect(card.getAttribute("data-scope-kind")).toBe("project");
      expect(card.getAttribute("data-session-id")).toBe("");
    }
  });
});

describe("the Portfolio/Board toggle is the same toggle on both rails", () => {
  it("Studio offers both tabs and starts on Portfolio", () => {
    mountStudio(PROJECT);
    expect(screen.getByRole("tab", { name: /portfolio/i })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /board/i })).not.toBeNull();
    expect(screen.getByTestId("card-wallets")).not.toBeNull();
  });

  it("choosing Board shows the board module and writes the shared preference", () => {
    mountStudio(PROJECT);
    fireEvent.click(screen.getByRole("tab", { name: /board/i }));
    expect(screen.getByTestId("board-module")).not.toBeNull();
    expect(useUiStore.getState().bookTab).toBe("board");
  });

  it("a stored Board preference opens the Studio rail on Board", () => {
    useUiStore.setState({ bookTab: "board" });
    mountStudio(PROJECT);
    expect(
      screen.getByRole("tab", { name: /board/i }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("Studio rail - its chrome", () => {
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
    // Missing ids are appended at the end, never guessed into a default slot.
    expect(renderedSectionIds()).toEqual([
      "balances",
      ...STUDIO_ROWS.filter((row) => row.id !== "balances").map((row) => row.id),
    ]);
  });

  it("drops a session-only id that reached the Studio key", () => {
    useUiStore.setState({
      studioBookSectionOrder: ["trench", "session", "wallets"],
    });
    mountStudio(PROJECT);
    const rendered = renderedSectionIds();
    for (const row of SESSION_ONLY_ROWS) {
      expect(rendered).not.toContain(row.id);
    }
    expect(rendered[0]).toBe("wallets");
  });

  it("a keyboard reorder writes the STUDIO key and leaves the agent order alone", () => {
    useUiStore.setState({ bookSectionOrder: ["trench", "wallets"] });
    mountStudio(PROJECT);
    const handle = screen.getByRole("button", {
      name: new RegExp(`Reorder Position - position 1 of ${STUDIO_ROWS.length}`),
    });
    fireEvent.keyDown(handle, { key: "ArrowDown" });

    expect([...useUiStore.getState().studioBookSectionOrder]).toEqual(
      // Position moved one row down; every other row keeps its place.
      ["wallets", "position", ...STUDIO_ROWS.slice(2).map((row) => row.id)],
    );
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
    expect(screen.queryByTestId("card-wallets")).toBeNull();
  });
});

describe("agent mode is untouched", () => {
  it("still renders the session rail with its own instruments", () => {
    mountAgent(SESSION);
    expect(screen.getByLabelText("Session instrument")).not.toBeNull();
    expect(
      screen.getByTestId("card-balances").getAttribute("data-scope-kind"),
    ).toBe("session");
    const activity = screen.getByTestId("card-activity");
    expect(activity.getAttribute("data-scope-kind")).toBe("session");
    expect(activity.getAttribute("data-session-id")).toBe(SESSION);
  });

  it("reordering the agent rail leaves the STUDIO order alone", () => {
    useUiStore.setState({ studioBookSectionOrder: ["balances", "wallets"] });
    mountAgent(SESSION);
    const handle = screen.getByRole("button", {
      name: new RegExp(`Reorder Position - position 1 of ${PARITY.length}`),
    });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect([...useUiStore.getState().studioBookSectionOrder]).toEqual([
      "balances",
      "wallets",
    ]);
  });
});
