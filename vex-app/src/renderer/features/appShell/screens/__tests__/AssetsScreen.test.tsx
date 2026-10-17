/**
 * AssetsScreen - the All-assets page, a Portfolio subpage (opened from the
 * Balances section's "View all assets").
 *
 * Pins (mirroring the Sessions-screen shape in the AppShell suite):
 *   - `uiStore.shellRoute = { kind: "assets" }` mounts the screen through
 *     ShellScreens as a titled modal dialog ("All assets"),
 *   - EVERY portfolio token line renders (no top-5 cut here), as the Balances
 *     table's own rows under the same column heads, sorted largest USD first,
 *   - Escape closes back to `{ kind: "none" }` (the ShellScreen chrome's
 *     window-level listener, identical to MemoryScreen's shape), or to the
 *     page it was opened from (Portfolio); the crumb is the title bar's
 *     (docs/design/R3-MINIMAL.md section 9.2),
 *   - the quiet empty state invites rather than errors,
 *   - hide-dust: the screen's checkbox (default checked, `hideDustBalances`
 *     in uiStore) filters sub-cent priced rows and names the hidden count;
 *     toggling flips the persisted uiStore preference and re-shows/re-hides,
 *   - THE HISTORY KEY: rows with exact `(chainId, tokenAddress)` identity carry
 *     a visible token-history key and answer a row press; both route to
 *     `tokenHistory` with the row's identity + `returnTo: { kind: "assets",
 *     sessionId }`; identity-less rows carry NO key and no press,
 *   - SESSION SCOPE (C4): a `sessionId` on the route reads THAT session's
 *     portfolio (never the global one), retitles the screen, and rides along
 *     on the eye's `returnTo` so the close path restores the same scope,
 *   - PROJECT SCOPE (Studio parity): a `projectId` on the route reads THAT
 *     project's own selection, names the project in the title, and the
 *     token-history close path returns to the PROJECT register.
 *
 * The sibling screens and the portfolio query hook are mocked - this suite
 * owns the assets branch, not Memory/Sessions/HowVexWorks/TokenHistory or
 * query wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PortfolioDto, PositionTokenDto } from "@shared/schemas/portfolio.js";
import { useUiStore } from "../../../../stores/uiStore.js";

// Every brand mark stubs to null, whatever its name: the marks are
// presentation-only here, and a hand-listed mock breaks the whole suite
// file each time a component references a new mark.
vi.mock("@thesvg/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thesvg/react")>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, () => null]));
});

// Sibling screens pull heavy registers (MemoryPanel, the sessions library);
// only the assets branch is under test.
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
// Phase 2b: SettingsScreen hosts the wizard step forms - a heavy module
// graph this suite's partial mocks do not cover. Own suite covers it.
vi.mock("../SettingsScreen.js", () => ({ SettingsScreen: () => null }));
// The Portfolio page owns its own suite; here it is only where a close or the
// crumb lands.
vi.mock("../PortfolioScreen.js", () => ({ PortfolioScreen: () => null }));
// The token-history screen itself is owned by TokenHistoryScreen.test.tsx;
// here a stub exposing its `onClose` wire is enough to pin ShellScreens'
// returnTo routing back into THIS screen.
vi.mock("../TokenHistoryScreen.js", () => ({
  TokenHistoryScreen: ({ onClose }: { readonly onClose: () => void }) => (
    <button type="button" aria-label="Close token history (stub)" onClick={onClose} />
  ),
}));

const mockUsePortfolio = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
}));
// The project's name is a label read for the title; the project arm below
// scripts it, the other arms never ask (the hook is disabled by `null`).
const mockUseProject = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/projects.js", () => ({
  useProject: mockUseProject,
}));

const { ShellScreens } = await import("../ShellScreens.js");

const ORIGIN = { x: 12, y: 640, width: 320, height: 40 };

function token(overrides: Partial<PositionTokenDto>): PositionTokenDto {
  return {
    chainId: 1,
    symbol: "TOK",
    balanceUsd: 1,
    amount: 1,
    ...overrides,
  };
}

function portfolio(tokens: readonly PositionTokenDto[]): PortfolioDto {
  return {
    scope: "global",
    walletCount: 2,
    liveTotalUsd: 999,
    snapshotTotalUsd: null,
    pnlVsPrev: null,
    snapshotAt: null,
    tokens: [...tokens],
    chains: [],
  };
}

/** Six lines - more than the Balances card's five, proving the full list. */
const SIX_TOKENS: readonly PositionTokenDto[] = [
  token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 600 }),
  token({ tokenName: "Token B", symbol: "BBB", balanceUsd: 500 }),
  token({ tokenName: "Token C", symbol: "CCC", balanceUsd: 300 }),
  token({ tokenName: "Token D", symbol: "DDD", balanceUsd: 100 }),
  token({ tokenName: "Token E", symbol: "EEE", balanceUsd: 50 }),
  token({ tokenName: "Token F", symbol: "FFF", balanceUsd: 25 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({
    shellRoute: { kind: "none" },
    hideDustBalances: true,
  });
  mockUseProject.mockReturnValue({ isLoading: false, isError: false, data: undefined });
  mockUsePortfolio.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: portfolio(SIX_TOKENS) },
  });
});

afterEach(() => {
  cleanup();
});

describe("AssetsScreen", () => {
  it("opens via uiStore as the titled All-assets dialog listing EVERY token line", () => {
    const view = render(<ShellScreens />);
    expect(screen.queryByRole("dialog", { name: "All assets" })).toBeNull();

    act(() => {
      useUiStore.getState().setShellRoute({ kind: "assets", origin: ORIGIN, sessionId: null });
    });

    expect(screen.getByRole("dialog", { name: "All assets" })).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "All assets" }),
    ).not.toBeNull();
    // All six lines render - the card's top-5 cut does not apply here.
    const rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain("Token A");
    expect(rows[5]).toContain("Token F");
  });

  it("closes on Escape back to the page it was opened from, and draws no crumb of its own", () => {
    render(<ShellScreens />);
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "portfolio", origin: null });
    });
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "assets", origin: ORIGIN, sessionId: null });
    });
    // The title bar carries the crumb; the page starts with its register.
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    // Back where the user came from, never the bare shell.
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "portfolio", origin: null });
  });

  it("closes on Escape back to shellRoute 'none' (ShellScreen chrome contract)", () => {
    useUiStore.setState({ shellRoute: { kind: "assets", origin: ORIGIN, sessionId: null } });
    render(<ShellScreens />);
    expect(screen.getByRole("dialog", { name: "All assets" })).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("states the quiet empty invitation when no balances exist", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio([]) },
    });
    useUiStore.setState({ shellRoute: { kind: "assets", origin: null, sessionId: null } });
    render(<ShellScreens />);
    expect(
      screen.getByText(/No balances yet\. Fund a wallet/i),
    ).not.toBeNull();
  });
});

describe("AssetsScreen - copy", () => {
  it("states every empty and dust line with full stops, never a hyphen standing in for a dash", () => {
    const lines: string[] = [];
    for (const route of [
      { kind: "assets", origin: null, sessionId: null },
      { kind: "assets", origin: null, sessionId: "00000000-0000-4000-8000-0000000000ab" },
      { kind: "assets", origin: null, projectId: "9c1b0e8e-0000-4000-8000-0000000000ab" },
    ] as const) {
      mockUsePortfolio.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { ok: true, data: portfolio([]) },
      });
      useUiStore.setState({ shellRoute: route });
      const view = render(<ShellScreens />);
      lines.push(view.container.querySelector(".vex-scan-note")?.textContent ?? "");
      cleanup();
    }
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio([token({ tokenName: "Seeyuh", balanceUsd: 0.001 })]) },
    });
    useUiStore.setState({ shellRoute: { kind: "assets", origin: null, sessionId: null } });
    const dust = render(<ShellScreens />);
    lines.push(
      [...dust.container.querySelectorAll(".vex-scan-note")].map((note) => note.textContent).join(" | "),
    );

    expect(lines[0]).toBe("No balances yet. Fund a wallet and every asset appears here.");
    expect(lines[3]).toContain('Every asset here is dust. Uncheck "Hide dust" to view.');
    for (const line of lines) expect(line).not.toMatch(/ [-\u2013\u2014] /);
  });
});

describe("AssetsScreen - token-history eye", () => {
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("renders the eye ONLY for rows with exact identity and routes to tokenHistory with returnTo 'assets'", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: portfolio([
          token({
            tokenName: "USD Coin",
            symbol: "USDC",
            chainId: 8453,
            tokenAddress: USDC_BASE,
            balanceUsd: 100,
          }),
          // No tokenAddress → no exact identity → NO eye (plan rule).
          token({ tokenName: "Legacy Row", symbol: "OLD", balanceUsd: 50 }),
        ]),
      },
    });
    useUiStore.setState({ shellRoute: { kind: "assets", origin: null, sessionId: null } });
    render(<ShellScreens />);

    // Exactly one eye: the identity-less row stays non-interactive.
    const eyes = screen.getAllByRole("button", { name: /^Token history:/ });
    expect(eyes).toHaveLength(1);
    expect(eyes[0]!.getAttribute("aria-label")).toBe("Token history: USD Coin");

    fireEvent.click(eyes[0]!);
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("tokenHistory");
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.token).toEqual({
      chainId: 8453,
      tokenAddress: USDC_BASE,
      symbol: "USDC",
      tokenName: "USD Coin",
    });
    expect(route.returnTo).toEqual({ kind: "assets", sessionId: null });
    // jsdom rects are all-zero - the pin is that a measured rect object
    // (not null) rode along as the expand origin.
    expect(route.origin).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("closing the token-history screen returns to the All-assets screen (remounted, centered)", () => {
    useUiStore.setState({
      shellRoute: {
        kind: "tokenHistory",
        origin: { x: 1, y: 2, width: 3, height: 4 },
        token: {
          chainId: 8453,
          tokenAddress: USDC_BASE,
          symbol: "USDC",
          tokenName: "USD Coin",
        },
        returnTo: { kind: "assets", sessionId: null },
      },
    });
    render(<ShellScreens />);
    expect(screen.queryByRole("dialog", { name: "All assets" })).toBeNull();

    // The stub's close wire is the same `onClose` the real screen's Escape/
    // close-key path fires (TokenHistoryScreen.test pins the Escape half).
    fireEvent.click(
      screen.getByRole("button", { name: "Close token history (stub)" }),
    );
    // Back to assets - with a NULL origin: the old morph rect belonged to a
    // row instance that no longer exists (no stale-origin morph).
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: null,
      sessionId: null,
    });
    expect(screen.getByRole("dialog", { name: "All assets" })).not.toBeNull();
  });
});

describe("AssetsScreen - hide dust", () => {
  /** 4 real (well-priced) rows + 2 sub-cent dust rows. */
  const TOKENS_WITH_DUST: readonly PositionTokenDto[] = [
    token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 600 }),
    token({ tokenName: "Token B", symbol: "BBB", balanceUsd: 500 }),
    token({ tokenName: "Token C", symbol: "CCC", balanceUsd: 300 }),
    token({ tokenName: "Token D", symbol: "DDD", balanceUsd: 100 }),
    token({ tokenName: "Seeyuh", symbol: "SEEYUH", balanceUsd: 0.001 }),
    token({ tokenName: "Dust Two", symbol: "DUST2", balanceUsd: 0.002 }),
  ];

  function mountAssetsScreen(): ReturnType<typeof render> {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio(TOKENS_WITH_DUST) },
    });
    useUiStore.setState({ shellRoute: { kind: "assets", origin: null, sessionId: null } });
    return render(<ShellScreens />);
  }

  it("hides dust rows by default (checkbox checked) and names the hidden count", () => {
    const view = mountAssetsScreen();
    const checkbox = screen.getByRole("checkbox", { name: /Hide dust/i });
    expect(checkbox).toHaveProperty("checked", true);

    const rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(4);
    expect(rows.some((row) => row.includes("Seeyuh"))).toBe(false);
    expect(rows.some((row) => row.includes("Dust Two"))).toBe(false);
    expect(screen.getByText(/2 dust assets hidden/i)).not.toBeNull();
  });

  it("toggling the checkbox reveals dust rows, flips + persists uiStore, and clears the note; toggling again re-hides", () => {
    const view = mountAssetsScreen();
    const checkbox = screen.getByRole("checkbox", { name: /Hide dust/i });

    fireEvent.click(checkbox);
    expect(useUiStore.getState().hideDustBalances).toBe(false);
    const persisted = JSON.parse(
      window.localStorage.getItem("vex-ui") ?? "{}",
    );
    expect(persisted.state.hideDustBalances).toBe(false);

    let rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(6);
    expect(rows.some((row) => row.includes("Seeyuh"))).toBe(true);
    expect(rows.some((row) => row.includes("Dust Two"))).toBe(true);
    expect(screen.queryByText(/dust assets? hidden/i)).toBeNull();

    fireEvent.click(checkbox);
    expect(useUiStore.getState().hideDustBalances).toBe(true);
    rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(4);
    expect(rows.some((row) => row.includes("Seeyuh"))).toBe(false);
    expect(screen.getByText(/2 dust assets hidden/i)).not.toBeNull();
  });
});

describe("AssetsScreen - session scope (C4)", () => {
  const SESSION = "00000000-0000-4000-8000-0000000000ab";
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("reads the SESSION portfolio, not the global one, and says so in the title", () => {
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, sessionId: SESSION },
    });
    render(<ShellScreens />);
    // The scope reaches the query hook - a narrowed register must never be
    // fed the global read.
    // The hook takes the WHOLE validated read input now, not a
    // `string | null` session id: that parameter could not express the B0
    // project scope and collapsed it to `null`, which IS the global aggregate.
    // The property asserted is unchanged - this card reads the SESSION, never
    // the global inventory.
    expect(mockUsePortfolio).toHaveBeenCalledWith({
      scope: "session",
      sessionId: SESSION,
    });
    expect(
      screen.getByRole("dialog", { name: "Session assets" }),
    ).not.toBeNull();
  });

  it("carries the session scope onto the eye's returnTo, so the close path restores it", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: portfolio([
          token({
            tokenName: "USD Coin",
            symbol: "USDC",
            chainId: 8453,
            tokenAddress: USDC_BASE,
            balanceUsd: 100,
          }),
        ]),
      },
    });
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, sessionId: SESSION },
    });
    render(<ShellScreens />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Token history:/ })[0]!,
    );
    const route = useUiStore.getState().shellRoute;
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.returnTo).toEqual({ kind: "assets", sessionId: SESSION });
  });

  it("states the SESSION empty invitation, never the global one", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio([]) },
    });
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, sessionId: SESSION },
    });
    render(<ShellScreens />);
    expect(
      screen.getByText(/No balances in this session's wallets yet/i),
    ).not.toBeNull();
  });
});

describe("AssetsScreen - project scope (Studio parity)", () => {
  const PROJECT = "9c1b0e8e-0000-4000-8000-0000000000ab";
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("reads the PROJECT portfolio and names the project in the title", () => {
    mockUseProject.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: { id: PROJECT, name: "vex-core" } },
    });
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, projectId: PROJECT },
    });
    render(<ShellScreens />);
    expect(mockUsePortfolio).toHaveBeenCalledWith({
      scope: "project",
      projectId: PROJECT,
    });
    expect(mockUseProject).toHaveBeenCalledWith(PROJECT);
    expect(
      screen.getByRole("dialog", { name: "Project assets: vex-core" }),
    ).not.toBeNull();
  });

  it("carries no name while the project read has not answered", () => {
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, projectId: PROJECT },
    });
    render(<ShellScreens />);
    expect(screen.getByRole("dialog", { name: "Project assets" })).not.toBeNull();
  });

  it("the token-history close path returns to the PROJECT register, never the global one", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: portfolio([
          token({
            tokenName: "USD Coin",
            symbol: "USDC",
            chainId: 8453,
            tokenAddress: USDC_BASE,
            balanceUsd: 100,
          }),
        ]),
      },
    });
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, projectId: PROJECT },
    });
    render(<ShellScreens />);
    fireEvent.click(screen.getByRole("button", { name: "Token history: USD Coin" }));
    const route = useUiStore.getState().shellRoute;
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.returnTo).toEqual({ kind: "assets", projectId: PROJECT });

    fireEvent.click(
      screen.getByRole("button", { name: "Close token history (stub)" }),
    );
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: null,
      projectId: PROJECT,
    });
  });

  it("states the PROJECT empty invitation", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio([]) },
    });
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, projectId: PROJECT },
    });
    render(<ShellScreens />);
    expect(
      screen.getByText(/No balances in this project's wallets yet/i),
    ).not.toBeNull();
  });
});

describe("AssetsScreen - column heads and the way into a token's history (review problem 10d)", () => {
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const WETH = "0x4200000000000000000000000000000000000006";

  function mountRegister(projectId?: string): ReturnType<typeof render> {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: portfolio([
          token({
            tokenName: "USD Coin",
            symbol: "USDC",
            chainId: 8453,
            tokenAddress: USDC_BASE,
            balanceUsd: 100,
          }),
          token({
            tokenName: "Wrapped Ether",
            symbol: "WETH",
            chainId: 1,
            tokenAddress: WETH,
            balanceUsd: 90,
            amount: null,
          }),
          // No tokenAddress: no exact identity, so nothing to open.
          token({ tokenName: "Legacy Row", symbol: "OLD", balanceUsd: 50 }),
        ]),
      },
    });
    useUiStore.setState({
      shellRoute:
        projectId === undefined
          ? { kind: "assets", origin: null, sessionId: null }
          : { kind: "assets", origin: null, projectId },
    });
    return render(<ShellScreens />);
  }

  const routeOf = () => useUiStore.getState().shellRoute;

  it("heads the register with the Balances heads: Asset, Network, Quantity, Price, Value", () => {
    mountRegister();
    const heads = screen.getAllByRole("columnheader");
    expect(heads.map((head) => head.textContent)).toEqual([
      "Asset",
      "Network",
      "Quantity",
      "Price",
      "Value",
      "Token history",
    ]);
    // The table is the Balances table (same class, so the same head style),
    // not a list that borrows its look.
    const table = document.querySelector('[data-vex-area="assets-register"]');
    expect(table?.tagName).toBe("TABLE");
    expect(table?.classList.contains("vex-pf-t")).toBe(true);
    expect(table?.classList.contains("vex-pf-t--balances")).toBe(true);
  });

  it("says Not available for a figure the read lacks, never a dash or $0.00", () => {
    mountRegister();
    const weth = [...document.querySelectorAll("tbody tr")].find((row) =>
      (row.textContent ?? "").includes("Wrapped Ether"),
    );
    const cells = [...(weth?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);
    expect(cells[2]).toBe("Not available");
    expect(cells[3]).toBe("Not available");
    expect(cells[4]).toBe("$90.00");
  });

  it("offers a visible, keyboard-reachable key on every row that has a history, named for its token", () => {
    mountRegister();
    const keys = screen.getAllByRole("button", { name: /^Token history:/ });
    expect(keys.map((key) => key.getAttribute("aria-label"))).toEqual([
      "Token history: USD Coin",
      "Token history: Wrapped Ether",
    ]);
    for (const key of keys) {
      expect(key.tagName).toBe("BUTTON");
      expect(key.getAttribute("type")).toBe("button");
      expect(key.hasAttribute("hidden")).toBe(false);
      expect(key.hasAttribute("tabindex")).toBe(false);
      expect(key.querySelector("svg")).not.toBeNull();
      key.focus();
      expect(document.activeElement).toBe(key);
    }
    // The identity-less row has no key and no press.
    const legacy = [...document.querySelectorAll("tbody tr")].find((row) =>
      (row.textContent ?? "").includes("Legacy Row"),
    );
    expect(legacy?.querySelector("button")).toBeNull();
    expect(legacy?.hasAttribute("data-vex-press")).toBe(false);
  });

  it("opens the token history from the key, once, carrying the register's scope", () => {
    mountRegister();
    const seen: string[] = [];
    const stop = useUiStore.subscribe((state) => seen.push(state.shellRoute.kind));
    fireEvent.click(screen.getByRole("button", { name: "Token history: Wrapped Ether" }));
    stop();

    // One route change: the key's click does not bubble into a second press.
    expect(seen).toEqual(["tokenHistory"]);
    const route = routeOf();
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.token).toEqual({
      chainId: 1,
      tokenAddress: WETH,
      symbol: "WETH",
      tokenName: "Wrapped Ether",
    });
    expect(route.returnTo).toEqual({ kind: "assets", sessionId: null });
  });

  it("opens the token history from a press on the row, the way the key does", () => {
    mountRegister();
    const row = [...document.querySelectorAll("tbody tr")].find((candidate) =>
      (candidate.textContent ?? "").includes("USD Coin"),
    );
    expect(row?.hasAttribute("data-vex-press")).toBe(true);
    // The press lands on the name, as a pointer does.
    fireEvent.click(screen.getByText("USD Coin"));

    const route = routeOf();
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.token.tokenAddress).toBe(USDC_BASE);
    expect(route.returnTo).toEqual({ kind: "assets", sessionId: null });
    // The row's rect rides along as the morph origin.
    expect(route.origin).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("a press on a row with no history opens nothing", () => {
    mountRegister();
    fireEvent.click(screen.getByText("Legacy Row"));
    expect(routeOf().kind).toBe("assets");
  });

  it("carries a project register's scope onto the route a row press opens", () => {
    mountRegister("9c1b0e8e-0000-4000-8000-0000000000ab");
    fireEvent.click(screen.getByText("USD Coin"));
    const route = routeOf();
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.returnTo).toEqual({
      kind: "assets",
      projectId: "9c1b0e8e-0000-4000-8000-0000000000ab",
    });
  });
});
