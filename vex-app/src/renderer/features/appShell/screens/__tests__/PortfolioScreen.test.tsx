/**
 * PortfolioScreen - the `portfolio` page in the centre column (docs/design/
 * R3-MINIMAL.md sections 2.3 and 9.1).
 *
 * Pins (composition, not the sections' own rules, which have their suites):
 *   - the chrome: the titled "Portfolio" dialog, a hidden h1, Escape closing,
 *   - the page top to bottom: the total (`PositionBlock`, with the refresh key
 *     and the chips), the reorderable sections in the user's stored order
 *     (`bookSectionOrder`: ids wallets, balances, lighter, activity,
 *     launchpads), then the $VEX line,
 *   - the band: Wallets and Balances share it wherever the order puts them
 *     next to each other (`data-vex-band` start/end on the list items, the
 *     lead on the list); apart, nothing is banded. Legacy ids are dropped and a
 *     missing id is appended; a keyboard move persists through the store,
 *   - the page asks for GLOBAL reads by default, never a session or a project,
 *   - the scope chips: only when there is more than one option; the wallet
 *     chips read the wallet scope; "This chat" while an agent session is open
 *     outside Studio and "This project" in Studio with a project selected,
 *     each handing its scope to every section; a chip that vanished falls back
 *     to All wallets.
 *
 * The REAL query layer and sections run, with only the `window.vex` bridge
 * faked. The heavy sections (the Lighter account, Activity, the Launchpad and
 * the $VEX line) are stubbed with light ones that echo their scope props.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PortfolioDto,
  PortfolioReadInput,
  PositionTokenDto,
} from "@shared/schemas/portfolio.js";
import type {
  AvailableWalletDto,
  AvailableWalletsDto,
} from "@shared/schemas/wallets.js";
import type { SessionWalletScopeDto } from "@shared/schemas/wallets/session-available.js";
import { ok, type Result } from "@shared/ipc/result.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { walletsKeys } from "../../../../lib/api/queryKeys.js";

// Every brand mark stubs to null, whatever its name: the marks are
// presentation-only here.
vi.mock("@thesvg/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thesvg/react")>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, () => null]));
});

// The heavy sections, stubbed with light ones that echo what they are handed.
vi.mock("../../book/portfolio/LighterAccountCard.js", () => ({
  LighterAccountCard: () => <div data-testid="lighter-stub" />,
}));
vi.mock("../../book/SessionActivityCard.js", () => ({
  SessionActivityCard: ({
    scope,
    allWallets,
  }: {
    readonly scope: { readonly kind: string };
    readonly allWallets?: boolean;
  }) => (
    <div
      data-testid="activity-stub"
      data-scope={JSON.stringify(scope)}
      data-all-wallets={String(allWallets === true)}
    />
  ),
}));
vi.mock("../../book/ImageLockerCard.js", () => ({
  ImageLockerCard: ({
    scope,
    chatOpen,
  }: {
    readonly scope: { readonly kind: string };
    readonly chatOpen?: boolean;
  }) => (
    <div
      data-testid="launchpad-stub"
      data-scope={JSON.stringify(scope)}
      data-chat-open={String(chatOpen === true)}
    />
  ),
}));
vi.mock("../../market/VexTokenCardCompact.js", () => ({
  VexTokenCardCompact: () => <div data-vex-area="vex-token-compact" />,
}));

const readMock = vi.fn<(input: PortfolioReadInput) => Promise<Result<PortfolioDto>>>();
const listAvailableMock =
  vi.fn<(input: Record<string, never>) => Promise<Result<AvailableWalletsDto>>>();
const listSessionWalletsMock =
  vi.fn<(input: { sessionId: string }) => Promise<Result<SessionWalletScopeDto>>>();
const projectsGetMock =
  vi.fn<(input: { projectId: string }) => Promise<Result<object | null>>>();

const { PortfolioScreen } = await import("../PortfolioScreen.js");

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const PROJECT = "00000000-0000-4000-8000-0000000000bb";
const MAIN: AvailableWalletDto = {
  id: "evm-1",
  family: "evm",
  address: "0x1111111111111111111111111111111111111111",
  label: "Main",
};
const SOL: AvailableWalletDto = {
  id: "sol-1",
  family: "solana",
  address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  label: "",
};
const SESSION_ADDR = "0x3333333333333333333333333333333333333333";
const PROJECT_ADDR = "0x4444444444444444444444444444444444444444";

const DEFAULT_ORDER = ["wallets", "balances", "lighter", "activity", "launchpads"];

function named(tokenName: string, balanceUsd: number): PositionTokenDto {
  return { chainId: 1, symbol: "TOK", tokenName, balanceUsd, amount: 1 };
}

function portfolio(overrides: Partial<PortfolioDto>): PortfolioDto {
  return {
    scope: "global",
    walletCount: 2,
    liveTotalUsd: 1234.56,
    snapshotTotalUsd: null,
    pnlVsPrev: null,
    snapshotAt: null,
    tokens: [],
    chains: [],
    ...overrides,
  };
}

/** Each read answers with its own figure and its own token line. */
function answer(input: PortfolioReadInput): Result<PortfolioDto> {
  switch (input.scope) {
    case "global":
      if (input.walletAddress === MAIN.address) {
        return ok(
          portfolio({
            walletCount: 1,
            liveTotalUsd: 111.11,
            tokens: [named("Wallet Token", 111)],
          }),
        );
      }
      if (input.walletAddress !== undefined) {
        return ok(portfolio({ walletCount: 1, liveTotalUsd: 5 }));
      }
      return ok(portfolio({ tokens: [named("Global Token", 900)] }));
    case "session":
      return ok(
        portfolio({
          scope: "session",
          walletCount: 1,
          liveTotalUsd: 40,
          tokens: [named("Session Token", 40)],
        }),
      );
    case "project":
      return ok(
        portfolio({
          scope: "project",
          walletCount: 1,
          liveTotalUsd: 75,
          tokens: [named("Project Token", 75)],
        }),
      );
  }
}

function inventory(
  evm: readonly AvailableWalletDto[],
  solana: readonly AvailableWalletDto[],
): Result<AvailableWalletsDto> {
  return ok({ evm: [...evm], solana: [...solana] });
}

function installVexBridge(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      portfolio: { read: readMock },
      wallets: {
        listAvailable: listAvailableMock,
        listSessionWallets: listSessionWalletsMock,
      },
      projects: { get: projectsGetMock },
    },
  });
}

const onClose = vi.fn();

function renderPage(): { readonly client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PortfolioScreen origin={null} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { client };
}

function header(): HTMLElement {
  const found = document.querySelector('[data-vex-area="portfolio-total"]');
  if (!(found instanceof HTMLElement)) throw new Error("missing the total header");
  return found;
}

function sectionList(): HTMLElement {
  const found = document.querySelector("ul.vex-pf__sections");
  if (!(found instanceof HTMLElement)) throw new Error("missing the sections list");
  return found;
}

function sectionItems(): readonly HTMLElement[] {
  return [...sectionList().querySelectorAll("li[data-vex-portfolio-section]")].filter(
    (item): item is HTMLElement => item instanceof HTMLElement,
  );
}

function sectionOrder(): readonly (string | null)[] {
  return sectionItems().map((item) => item.getAttribute("data-vex-portfolio-section"));
}

function section(id: string): HTMLElement {
  const found = sectionItems().find(
    (item) => item.getAttribute("data-vex-portfolio-section") === id,
  );
  if (found === undefined) throw new Error(`missing section ${id}`);
  return found;
}

function stub(testId: string): HTMLElement {
  const found = screen.getByTestId(testId);
  if (!(found instanceof HTMLElement)) throw new Error(`missing stub ${testId}`);
  return found;
}

function chipGroup(): HTMLElement | null {
  return screen.queryByRole("group", { name: "Portfolio scope" });
}

function chip(name: string | RegExp): HTMLElement {
  const group = chipGroup();
  if (group === null) throw new Error("the scope chips are not offered");
  return within(group).getByRole("button", { name });
}

function chipNames(): readonly string[] {
  const group = chipGroup();
  if (group === null) return [];
  return within(group)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
}

function readInputs(): readonly PortfolioReadInput[] {
  return readMock.mock.calls.map(([input]) => input);
}

/** The page's first full paint under the default scope. */
async function settleGlobal(): Promise<void> {
  await within(header()).findByText("$1,234.56");
  await within(section("balances")).findByText("Global Token");
  await within(section("wallets")).findByText("Total");
}

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockReset();
  readMock.mockImplementation((input) => Promise.resolve(answer(input)));
  listAvailableMock.mockReset();
  listAvailableMock.mockResolvedValue(inventory([MAIN], [SOL]));
  listSessionWalletsMock.mockReset();
  listSessionWalletsMock.mockResolvedValue(
    ok({
      sessionId: SESSION,
      evm: { walletId: "s-evm", address: SESSION_ADDR, label: "Chat wallet" },
      solana: null,
    }),
  );
  projectsGetMock.mockReset();
  projectsGetMock.mockResolvedValue(
    ok({
      id: PROJECT,
      name: "Acme",
      wallets: { evm: { id: "p-evm", address: PROJECT_ADDR }, solana: null },
    }),
  );
  installVexBridge();
  window.localStorage.clear();
  useUiStore.setState({
    shellRoute: { kind: "none" },
    runtimeMode: "agent",
    activeSessionId: null,
    activeProjectId: null,
    bookSectionOrder: [],
    hideDustBalances: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("PortfolioScreen - the chrome", () => {
  it("opens as the titled Portfolio dialog with a hidden h1", async () => {
    renderPage();
    await settleGlobal();

    const dialog = screen.getByRole("dialog", { name: "Portfolio" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", { level: 1, name: "Portfolio" });
    // The page draws its own head (the total): the page's h1 stays for
    // assistive tech only.
    expect(heading.classList.contains("sr-only")).toBe(true);
    // The title bar owns the close key and the crumb; the page draws neither.
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("closes through the host's close on Escape when there is no page to return to", async () => {
    renderPage();
    await settleGlobal();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PortfolioScreen - composition", () => {
  it("draws the total, then the sections, then the $VEX line, with the refresh key in the head", async () => {
    renderPage();
    await settleGlobal();

    const total = header();
    const list = sectionList();
    const vex = document.querySelector('[data-vex-area="vex-token-compact"]');
    if (vex === null) throw new Error("missing the $VEX line");
    expect(total.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(list.compareDocumentPosition(vex)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(total).getByRole("button", { name: "Refresh portfolio" }),
    ).not.toBeNull();
    // What the total includes, and the headline.
    expect(
      within(total).getByText(
        "Total value of your 2 on-chain wallets · Lighter is shown separately",
      ),
    ).not.toBeNull();
  });

  it("lists the five sections in the default order, each in its own seam", async () => {
    renderPage();
    await settleGlobal();

    expect(sectionOrder()).toEqual(DEFAULT_ORDER);
    // The sr-only live region closes the list: it is not a section.
    const items = [...sectionList().children];
    expect(items).toHaveLength(6);
    expect(items[5]?.getAttribute("aria-live")).toBe("polite");
    expect(items[5]?.classList.contains("sr-only")).toBe(true);
  });

  it("composes the real Wallets and Balances sections and the light stubs for the rest", async () => {
    renderPage();
    await settleGlobal();

    expect(
      section("wallets").querySelector('[data-vex-area="portfolio-wallets"]'),
    ).not.toBeNull();
    expect(
      section("balances").querySelector('[data-vex-area="portfolio-balances"]'),
    ).not.toBeNull();
    expect(section("lighter").querySelector('[data-testid="lighter-stub"]')).not.toBeNull();
    expect(section("activity").querySelector('[data-testid="activity-stub"]')).not.toBeNull();
    expect(section("launchpads").querySelector('[data-testid="launchpad-stub"]')).not.toBeNull();
    // Every section carries its reorder grip.
    for (const [id, label, index] of [
      ["wallets", "Wallets", 1],
      ["balances", "Balances", 2],
      ["lighter", "Lighter account", 3],
      ["activity", "Activity", 4],
      ["launchpads", "Launchpad", 5],
    ] as const) {
      expect(
        within(section(id)).getByRole("button", {
          name: `Reorder ${label} - position ${index} of 5`,
        }),
      ).not.toBeNull();
    }
  });

  it("hands the global scope to Activity and the Launchpad by default", async () => {
    renderPage();
    await settleGlobal();

    expect(stub("activity-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "global" }),
    );
    expect(stub("activity-stub").getAttribute("data-all-wallets")).toBe("false");
    expect(stub("launchpad-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "global" }),
    );
    expect(stub("launchpad-stub").getAttribute("data-chat-open")).toBe("false");
  });
});

describe("PortfolioScreen - the Wallets and Balances band", () => {
  it("bands Wallets (start) beside Balances (end) in the default order", async () => {
    renderPage();
    await settleGlobal();

    expect(section("wallets").getAttribute("data-vex-band")).toBe("start");
    expect(section("balances").getAttribute("data-vex-band")).toBe("end");
    for (const id of ["lighter", "activity", "launchpads"]) {
      expect(section(id).hasAttribute("data-vex-band")).toBe(false);
    }
    expect(sectionList().getAttribute("data-vex-band-lead")).toBe("wallets");
  });

  it("follows the stored order: Balances first makes Balances the band's start", async () => {
    useUiStore.setState({
      bookSectionOrder: ["balances", "wallets", "activity", "lighter", "launchpads"],
    });
    renderPage();
    await settleGlobal();

    expect(sectionOrder()).toEqual([
      "balances",
      "wallets",
      "activity",
      "lighter",
      "launchpads",
    ]);
    expect(section("balances").getAttribute("data-vex-band")).toBe("start");
    expect(section("wallets").getAttribute("data-vex-band")).toBe("end");
    expect(sectionList().getAttribute("data-vex-band-lead")).toBe("balances");
  });

  it("forms no band when the order separates the two, each section spanning the page", async () => {
    useUiStore.setState({
      bookSectionOrder: ["wallets", "lighter", "balances", "activity", "launchpads"],
    });
    renderPage();
    await settleGlobal();

    expect(sectionOrder()).toEqual([
      "wallets",
      "lighter",
      "balances",
      "activity",
      "launchpads",
    ]);
    expect(document.querySelectorAll("[data-vex-band]")).toHaveLength(0);
    expect(sectionList().hasAttribute("data-vex-band-lead")).toBe(false);
  });

  it("drops the old panel's ids and appends a missing section at the end", async () => {
    useUiStore.setState({
      bookSectionOrder: [
        "launchpads",
        "position",
        "session",
        "wallets",
        "project",
        "runtime",
        "activity",
        "balances",
        "wallets",
      ],
    });
    renderPage();
    await settleGlobal();

    // Unknown ids are gone, a duplicate counts once, `lighter` (new) arrives last.
    expect(sectionOrder()).toEqual([
      "launchpads",
      "wallets",
      "activity",
      "balances",
      "lighter",
    ]);
    expect(document.querySelectorAll("[data-vex-band]")).toHaveLength(0);
  });

  it("a keyboard move persists through the store, announces itself and moves the band", async () => {
    renderPage();
    await settleGlobal();

    const grip = within(section("balances")).getByRole("button", {
      name: "Reorder Balances - position 2 of 5",
    });
    fireEvent.keyDown(grip, { key: "ArrowUp" });

    expect(useUiStore.getState().bookSectionOrder).toEqual([
      "balances",
      "wallets",
      "lighter",
      "activity",
      "launchpads",
    ]);
    expect(sectionOrder()).toEqual([
      "balances",
      "wallets",
      "lighter",
      "activity",
      "launchpads",
    ]);
    expect(sectionList().getAttribute("data-vex-band-lead")).toBe("balances");
    const live = sectionList().querySelector('li[aria-live="polite"]');
    expect(live?.textContent).toBe("Balances moved to position 1 of 5");
  });
});

describe("PortfolioScreen - the page asks for global reads by default", () => {
  it("reads the global portfolio and no session, project or session wallet read", async () => {
    renderPage();
    await settleGlobal();

    expect(readMock).toHaveBeenCalledWith({ scope: "global" });
    for (const input of readInputs()) expect(input.scope).toBe("global");
    expect(listSessionWalletsMock).not.toHaveBeenCalled();
    expect(projectsGetMock).not.toHaveBeenCalled();
    // The aggregate is what the head and Balances print.
    expect(within(header()).getByText("$1,234.56")).not.toBeNull();
    expect(within(section("balances")).getByText("Global Token")).not.toBeNull();
    // The Wallets section is the inventory table with its Add wallet key.
    expect(
      within(section("wallets")).getByRole("button", { name: "Add wallet" }),
    ).not.toBeNull();
  });
});

describe("PortfolioScreen - the scope chips", () => {
  it("offers none with one wallet and no chat or project open", async () => {
    listAvailableMock.mockResolvedValue(inventory([MAIN], []));
    renderPage();
    await within(header()).findByText("$1,234.56");
    await within(section("wallets")).findByText("Total");

    expect(chipGroup()).toBeNull();
  });

  it("offers All wallets and one chip per wallet at two wallets, All wallets pressed", async () => {
    renderPage();
    await settleGlobal();

    const group = chipGroup();
    if (group === null) throw new Error("the scope chips are not offered");
    // The chips ride at the right of the total.
    expect(header().contains(group)).toBe(true);
    expect(chipNames()).toEqual([
      "All wallets",
      "Main · Primary",
      "SOL · Primary",
    ]);
    expect(chip("All wallets").getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^Main/).getAttribute("aria-pressed")).toBe("false");
    expect(chip(/^Main/).getAttribute("title")).toBe(MAIN.address);
  });

  it("selecting a wallet chip reads the wallet scope, and All wallets restores the aggregate", async () => {
    renderPage();
    await settleGlobal();

    fireEvent.click(chip(/^Main/));

    await within(header()).findByText("$111.11");
    expect(readMock).toHaveBeenCalledWith({
      scope: "global",
      walletAddress: MAIN.address,
    });
    expect(chip(/^Main/).getAttribute("aria-pressed")).toBe("true");
    expect(chip("All wallets").getAttribute("aria-pressed")).toBe("false");
    expect(
      within(header()).getByText("Total value of Main · Lighter is shown separately"),
    ).not.toBeNull();
    // Balances is that wallet's read, and offers no register of its own.
    await within(section("balances")).findByText("Wallet Token");
    expect(within(section("balances")).queryByText("Global Token")).toBeNull();
    expect(
      within(section("balances")).queryByRole("button", { name: /View all assets/ }),
    ).toBeNull();
    // The selected wallet's row is marked in the Wallets table.
    const selectedRow = section("wallets").querySelector('tr[data-selected="true"]');
    expect(selectedRow?.textContent).toContain("Main");
    expect(section("wallets").querySelectorAll("[data-selected]")).toHaveLength(1);
    // Activity narrows to every wallet's feed under a wallet scope.
    expect(stub("activity-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "global" }),
    );
    expect(stub("activity-stub").getAttribute("data-all-wallets")).toBe("true");

    fireEvent.click(chip("All wallets"));

    await within(header()).findByText("$1,234.56");
    await within(section("balances")).findByText("Global Token");
    expect(chip("All wallets").getAttribute("aria-pressed")).toBe("true");
    expect(section("wallets").querySelectorAll("[data-selected]")).toHaveLength(0);
    expect(stub("activity-stub").getAttribute("data-all-wallets")).toBe("false");
    expect(
      within(section("balances")).getByRole("button", { name: /View all assets/ }),
    ).not.toBeNull();
  });

  it.each(["agent", "lighter"] as const)(
    "offers This chat in %s mode while a session is open, and not This project",
    async (mode) => {
      useUiStore.setState({
        runtimeMode: mode,
        activeSessionId: SESSION,
        activeProjectId: PROJECT,
      });
      renderPage();
      await settleGlobal();

      expect(chipNames()).toEqual([
        "All wallets",
        "Main · Primary",
        "SOL · Primary",
        "This chat",
      ]);
    },
  );

  it("offers This project in Studio with a project selected, and not This chat", async () => {
    useUiStore.setState({
      runtimeMode: "studio",
      activeSessionId: SESSION,
      activeProjectId: PROJECT,
    });
    renderPage();
    await settleGlobal();

    expect(chipNames()).toEqual([
      "All wallets",
      "Main · Primary",
      "SOL · Primary",
      "This project",
    ]);
  });

  it("offers neither context chip without a session (agent) or a project (Studio)", async () => {
    renderPage();
    await settleGlobal();
    expect(chipNames()).not.toContain("This chat");
    expect(chipNames()).not.toContain("This project");
    cleanup();

    useUiStore.setState({ runtimeMode: "studio", activeSessionId: SESSION, activeProjectId: null });
    renderPage();
    await settleGlobal();
    expect(chipNames()).not.toContain("This chat");
    expect(chipNames()).not.toContain("This project");
  });

  it("a lone context chip is still offered with a single wallet: All wallets plus This chat", async () => {
    listAvailableMock.mockResolvedValue(inventory([MAIN], []));
    useUiStore.setState({ activeSessionId: SESSION });
    renderPage();
    await within(header()).findByText("$1,234.56");

    expect(chipNames()).toEqual(["All wallets", "This chat"]);
  });

  it("This chat hands the session scope to every section and reads only the session", async () => {
    useUiStore.setState({ activeSessionId: SESSION });
    renderPage();
    await settleGlobal();

    readMock.mockClear();
    fireEvent.click(chip("This chat"));

    await within(header()).findByText("$40.00");
    expect(chip("This chat").getAttribute("aria-pressed")).toBe("true");
    expect(readMock).toHaveBeenCalledWith({ scope: "session", sessionId: SESSION });
    // Never the un-narrowed global read once a chat is selected.
    expect(readInputs()).not.toContainEqual({ scope: "global" });
    expect(
      within(header()).getByText(
        "Total value of this chat's 1 on-chain wallet · Lighter is shown separately",
      ),
    ).not.toBeNull();
    // Balances is the session's own, and its register opens narrowed to it.
    await within(section("balances")).findByText("Session Token");
    fireEvent.click(within(section("balances")).getByRole("button", { name: /View all assets/ }));
    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "assets",
      origin: { x: 0, y: 0, width: 0, height: 0 },
      sessionId: SESSION,
    });
    // Wallets is the chat's pair: its own rows, no inventory and no Add wallet.
    await within(section("wallets")).findByText("Chat wallet");
    expect(listSessionWalletsMock).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(within(section("wallets")).queryByText("Total")).toBeNull();
    expect(
      within(section("wallets")).queryByRole("button", { name: "Add wallet" }),
    ).toBeNull();
    // Activity and the Launchpad take the session scope, the Launchpad knowing a chat is open.
    expect(stub("activity-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "session", sessionId: SESSION }),
    );
    expect(stub("activity-stub").getAttribute("data-all-wallets")).toBe("false");
    expect(stub("launchpad-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "session", sessionId: SESSION }),
    );
    expect(stub("launchpad-stub").getAttribute("data-chat-open")).toBe("true");
  });

  it("This project hands the project scope to every section and reads only the project", async () => {
    useUiStore.setState({
      runtimeMode: "studio",
      activeProjectId: PROJECT,
    });
    renderPage();
    await settleGlobal();

    readMock.mockClear();
    fireEvent.click(chip("This project"));

    await within(header()).findByText("$75.00");
    expect(readMock).toHaveBeenCalledWith({ scope: "project", projectId: PROJECT });
    expect(readInputs()).not.toContainEqual({ scope: "global" });
    expect(
      within(header()).getByText(
        "Total value of this project's 1 on-chain wallet · Lighter is shown separately",
      ),
    ).not.toBeNull();
    await within(section("balances")).findByText("Project Token");
    fireEvent.click(within(section("balances")).getByRole("button", { name: /View all assets/ }));
    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "assets",
      origin: { x: 0, y: 0, width: 0, height: 0 },
      projectId: PROJECT,
    });
    await waitFor(() => expect(projectsGetMock).toHaveBeenCalledWith({ projectId: PROJECT }));
    expect(listSessionWalletsMock).not.toHaveBeenCalled();
    expect(stub("activity-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "project", projectId: PROJECT }),
    );
    expect(stub("launchpad-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "project", projectId: PROJECT }),
    );
    expect(stub("launchpad-stub").getAttribute("data-chat-open")).toBe("false");
  });

  it("a chat that closes drops its chip and falls back to All wallets", async () => {
    useUiStore.setState({ activeSessionId: SESSION });
    renderPage();
    await settleGlobal();

    fireEvent.click(chip("This chat"));
    await within(header()).findByText("$40.00");

    act(() => {
      useUiStore.setState({ activeSessionId: null });
    });

    await within(header()).findByText("$1,234.56");
    expect(chipNames()).not.toContain("This chat");
    expect(chip("All wallets").getAttribute("aria-pressed")).toBe("true");
    await within(section("balances")).findByText("Global Token");
    // The inventory table is back, not the chat's pair.
    await within(section("wallets")).findByText("Total");
    expect(stub("activity-stub").getAttribute("data-scope")).toBe(
      JSON.stringify({ kind: "global" }),
    );
  });

  it("leaving the chat's mode for Studio drops This chat rather than keeping a dead selection", async () => {
    useUiStore.setState({ activeSessionId: SESSION, activeProjectId: PROJECT });
    renderPage();
    await settleGlobal();

    fireEvent.click(chip("This chat"));
    await within(header()).findByText("$40.00");

    act(() => {
      useUiStore.setState({ runtimeMode: "studio" });
    });

    await within(header()).findByText("$1,234.56");
    // Studio offers This project, but nothing selects it on the user's behalf.
    expect(chipNames()).toContain("This project");
    expect(chipNames()).not.toContain("This chat");
    expect(chip("All wallets").getAttribute("aria-pressed")).toBe("true");
    expect(chip("This project").getAttribute("aria-pressed")).toBe("false");
  });

  it("a wallet removed from the inventory drops its chips and falls back to All wallets", async () => {
    const { client } = renderPage();
    await settleGlobal();

    fireEvent.click(chip(/^Main/));
    await within(header()).findByText("$111.11");

    act(() => {
      client.setQueryData(walletsKeys.available(), inventory([MAIN], []));
    });

    await within(header()).findByText("$1,234.56");
    // One wallet left: the aggregate already is that wallet, so no chips at all.
    expect(chipGroup()).toBeNull();
    await within(section("balances")).findByText("Global Token");
    expect(section("wallets").querySelectorAll("[data-selected]")).toHaveLength(0);
  });
});
