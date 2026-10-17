/**
 * Characterization pins for the scope-driven Portfolio page sections (the
 * total, Wallets, Balances) around the page scope seam: a section's reads are
 * a function of the scope input it is handed, never of session state read
 * inside it. The REAL query layer runs here and only the `window.vex` bridge
 * is faked, so every assertion is on the IPC the section actually made (which
 * read fires, what renders), not on wiring.
 *
 *   - `PositionBlock`: the total reads exactly its scope (global, session,
 *     project, or the global read narrowed by one wallet's address) and keeps
 *     chain read uncertainty beside the cached figure,
 *   - `BalancesCard`: the same scope narrowing, the top five with dust cut
 *     BEFORE the cap, a different empty sentence per scope,
 *   - `WalletsCard`: one identity row per inventory wallet, each wallet's own
 *     figure, the inventory's own Total, the selected wallet, Add wallet and
 *     Copy address,
 *   - `WalletPairCard`: a session or project card never touches the global
 *     wallet inventory,
 *   - the page scope model: which chips exist and how a vanished one falls
 *     back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
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
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { useUiStore } from "../../../../../stores/uiStore.js";
import { PositionBlock } from "../../PositionBlock.js";
import { WalletPairCard } from "../../WalletPairCard.js";
import { WalletsCard } from "../WalletsCard.js";
import { BalancesCard } from "../BalancesCard.js";
import {
  ALL_WALLETS_KEY,
  THIS_CHAT_KEY,
  THIS_PROJECT_KEY,
  cardScopeOf,
  portfolioScopeOptions,
  selectScopeOption,
} from "../portfolio-page-scope.js";
import { flattenPortfolioWallets } from "../wallet-scope.js";

/** A full error envelope, as main would hand the renderer on a failed read. */
const READ_FAILED: VexError = {
  code: "internal.unexpected",
  domain: "system",
  message: "boom",
  retryable: false,
  userActionable: false,
  redacted: true,
  correlationId: "00000000-0000-4000-8000-0000000000ee",
};

const readMock = vi.fn<(input: PortfolioReadInput) => Promise<Result<PortfolioDto>>>();
const listAvailableMock =
  vi.fn<(input: Record<string, never>) => Promise<Result<AvailableWalletsDto>>>();
const listSessionWalletsMock =
  vi.fn<(input: { sessionId: string }) => Promise<Result<SessionWalletScopeDto>>>();
const projectsGetMock =
  vi.fn<(input: { projectId: string }) => Promise<Result<object | null>>>();
const writeTextMock = vi.fn<(text: string) => Promise<void>>();

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
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
}

function portfolio(overrides: Partial<PortfolioDto> = {}): PortfolioDto {
  return {
    scope: "global",
    walletCount: 2,
    liveTotalUsd: 1234.56,
    snapshotTotalUsd: 1200,
    pnlVsPrev: 34.56,
    snapshotAt: "2026-08-20T10:00:00.000Z",
    tokens: [],
    chains: [],
    ...overrides,
  };
}

const EVM_WALLET: AvailableWalletDto = {
  id: "evm-1",
  family: "evm",
  address: "0x1111111111111111111111111111111111111111",
  label: "Main",
};
const EVM_WALLET_2: AvailableWalletDto = {
  id: "evm-2",
  family: "evm",
  address: "0x2222222222222222222222222222222222222222",
  label: "",
};
const SOL_WALLET: AvailableWalletDto = {
  id: "sol-1",
  family: "solana",
  address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  label: "",
};

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const PROJECT = "00000000-0000-4000-8000-0000000000bb";
const ORIGIN_ZERO = { x: 0, y: 0, width: 0, height: 0 };

function token(symbol: string, usd: number | null): PositionTokenDto {
  return {
    chainId: 8453,
    symbol,
    tokenAddress: null,
    tokenName: null,
    balanceUsd: usd,
    amount: null,
  };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWith(ui: ReactNode) {
  return render(<QueryClientProvider client={newClient()}>{ui}</QueryClientProvider>);
}

/**
 * Same render, but hands back the client so a test can assert what the card
 * did NOT put in the cache. A disabled query leaves no entry under its key at
 * all, which is the observable difference between "fetched and ignored" and
 * "never read".
 */
function renderWithClient(ui: ReactNode): { readonly client: QueryClient } {
  const client = newClient();
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client };
}

function bodyRows(): readonly HTMLTableRowElement[] {
  return [...document.querySelectorAll("tbody tr")].filter(
    (row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement,
  );
}

function cellsOf(row: HTMLTableRowElement): readonly string[] {
  return [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
}

function rowContaining(text: string): HTMLTableRowElement {
  const row = bodyRows().find((candidate) => (candidate.textContent ?? "").includes(text));
  if (row === undefined) throw new Error(`no table row containing ${text}`);
  return row;
}

function balanceNames(): readonly string[] {
  return bodyRows().map(
    (row) => row.querySelector(".vex-pf-asset > span:last-child")?.textContent ?? "",
  );
}

/** Every input the bridge's portfolio read has been called with. */
function readInputs(): readonly PortfolioReadInput[] {
  return readMock.mock.calls.map(([input]) => input);
}

function inventory(
  evm: readonly AvailableWalletDto[],
  solana: readonly AvailableWalletDto[],
): Result<AvailableWalletsDto> {
  return ok({ evm: [...evm], solana: [...solana] });
}

beforeEach(() => {
  readMock.mockReset();
  listAvailableMock.mockReset();
  listSessionWalletsMock.mockReset();
  projectsGetMock.mockReset();
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue();
  installVexBridge();
  window.localStorage.clear();
  useUiStore.setState({ shellRoute: { kind: "none" }, hideDustBalances: true });
});

afterEach(cleanup);

describe("PositionBlock scope input", () => {
  it("a global scope reads the global portfolio and prints the full aggregate", async () => {
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<PositionBlock scope={{ kind: "global" }} chips={null} />);

    await screen.findByText("$1,234.56");
    expect(readMock).toHaveBeenCalledWith({ scope: "global" });
    expect(screen.getByText(/\$1,200\.00/)).not.toBeNull();
  });

  it("a session scope narrows the read to exactly that session id, never the global read", async () => {
    readMock.mockResolvedValue(
      ok(portfolio({ scope: "session", liveTotalUsd: 40 })),
    );
    renderWith(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} chips={null} />);

    await screen.findByText("$40.00");
    expect(readInputs()).toEqual([{ scope: "session", sessionId: SESSION }]);
    expect(readMock).not.toHaveBeenCalledWith({ scope: "global" });
  });

  it("a project scope narrows the read to exactly that project, never the global read", async () => {
    readMock.mockResolvedValue(
      ok(portfolio({ scope: "project", liveTotalUsd: 75 })),
    );
    renderWith(<PositionBlock scope={{ kind: "project", projectId: PROJECT }} chips={null} />);

    await screen.findByText("$75.00");
    expect(readInputs()).toEqual([{ scope: "project", projectId: PROJECT }]);
    expect(readMock).not.toHaveBeenCalledWith({ scope: "global" });
  });

  it("a wallet scope reads the global read narrowed by that wallet's address and shows its figure", async () => {
    readMock.mockImplementation((input) =>
      Promise.resolve(
        ok(
          input.scope === "global" && input.walletAddress !== undefined
            ? portfolio({ liveTotalUsd: 111.11, walletCount: 1 })
            : portfolio(),
        ),
      ),
    );
    renderWith(<PositionBlock scope={{ kind: "wallet", wallet: EVM_WALLET }} chips={null} />);

    await screen.findByText("$111.11");
    expect(readMock).toHaveBeenCalledWith({
      scope: "global",
      walletAddress: EVM_WALLET.address,
    });
    expect(screen.queryByText("$1,234.56")).toBeNull();
    // No session or project read is ever made for a wallet.
    for (const input of readInputs()) expect(input.scope).toBe("global");
  });

  it("never reads the global wallet inventory and leaves its cache row empty under a project scope", async () => {
    readMock.mockResolvedValue(ok(portfolio({ scope: "project" })));
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], [SOL_WALLET]));
    const { client } = renderWithClient(
      <PositionBlock scope={{ kind: "project", projectId: PROJECT }} chips={null} />,
    );
    // The scope's own read resolving is the settle point: the card has
    // mounted, run its effects and painted before the negative is asserted.
    await screen.findByText("$1,234.56");
    expect(listAvailableMock).not.toHaveBeenCalled();
    expect(client.getQueryData(["wallets", "available"])).toBeUndefined();
  });
});

describe("chain read uncertainty", () => {
  it("shows the stale chain and both timestamps beside cached portfolio value", async () => {
    const staleSince = "2026-09-08T20:37:00.000Z";
    const lastSuccessAt = "2026-09-07T10:00:00.000Z";
    readMock.mockResolvedValue(
      ok(
        portfolio({
          chainReadIssues: [
            {
              chainId: 20011000000,
              status: "read_failed",
              reason: "http_403",
              staleSince,
              lastSuccessAt,
            },
          ],
        }),
      ),
    );
    const { container } = renderWith(<PositionBlock scope={{ kind: "global" }} chips={null} />);

    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain("Solana: stale since");
    expect(warning.textContent).toContain("Totals include last known values");
    expect(container.querySelector(`time[datetime="${lastSuccessAt}"]`)).not.toBeNull();
    expect(container.querySelector(`time[datetime="${staleSince}"]`)).not.toBeNull();
    expect(screen.getByText("$1,234.56")).not.toBeNull();
  });

  it("labels missing new tokens without claiming that known balances are stale", async () => {
    readMock.mockResolvedValue(
      ok(
        portfolio({
          chainReadIssues: [
            {
              chainId: 4663,
              status: "inventory_incomplete",
              reason: "http_403",
              staleSince: "2026-09-08T20:37:00.000Z",
              lastSuccessAt: "2026-09-08T20:39:00.000Z",
            },
          ],
        }),
      ),
    );
    renderWith(<PositionBlock scope={{ kind: "global" }} chips={null} />);

    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain("new tokens on this chain may be missing since");
    expect(warning.textContent).toContain("Reason: http_403");
    expect(warning.textContent).not.toContain("Some balances are stale");
  });

  it("explains a Cloudflare challenge and points to the Blockscout override", async () => {
    readMock.mockResolvedValue(
      ok(
        portfolio({
          chainReadIssues: [
            {
              chainId: 4663,
              status: "inventory_incomplete",
              reason: "cloudflare_challenge",
              staleSince: "2026-09-09T07:00:00.000Z",
              lastSuccessAt: "2026-09-09T07:10:00.000Z",
            },
          ],
        }),
      ),
    );
    renderWith(<PositionBlock scope={{ kind: "global" }} chips={null} />);

    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain("public explorer refuses automated reads");
    expect(warning.textContent).toContain(
      "Blockscout base URL override in Settings > API keys > Chain endpoints",
    );
    expect(warning.textContent).not.toContain("Some balances are stale");
  });

  it("labels a partial snapshot and explains that its P&L is unavailable", async () => {
    readMock.mockResolvedValue(
      ok(
        portfolio({
          snapshotPartial: true,
          snapshotUnresolvedChainCount: 1,
          pnlVsPrev: null,
        }),
      ),
    );
    renderWith(<PositionBlock scope={{ kind: "global" }} chips={null} />);

    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain("Latest snapshot is partial (1 unresolved chain reads)");
    expect(warning.textContent).toContain("P&L is unavailable");
  });
});

describe("BalancesCard scope input", () => {
  it("a global scope reads the global portfolio, never a session one", async () => {
    readMock.mockResolvedValue(
      ok(portfolio({ tokens: [token("ETH", 900), token("USDC", 100)] })),
    );
    renderWith(<BalancesCard scope={{ kind: "global" }} />);

    await screen.findByText("ETH");
    expect(readInputs()).toEqual([{ scope: "global" }]);
  });

  it("a session scope narrows the read to exactly that session id", async () => {
    readMock.mockResolvedValue(
      ok(portfolio({ scope: "session", tokens: [token("SOL", 40)] })),
    );
    renderWith(<BalancesCard scope={{ kind: "session", sessionId: SESSION }} />);

    await screen.findByText("SOL");
    expect(readInputs()).toEqual([{ scope: "session", sessionId: SESSION }]);
  });

  it("a project scope narrows the read to exactly that project id", async () => {
    readMock.mockResolvedValue(
      ok(portfolio({ scope: "project", tokens: [token("POL", 40)] })),
    );
    renderWith(<BalancesCard scope={{ kind: "project", projectId: PROJECT }} />);

    await screen.findByText("POL");
    expect(readInputs()).toEqual([{ scope: "project", projectId: PROJECT }]);
  });

  it("a wallet scope reads the global read narrowed by that wallet's address", async () => {
    readMock.mockResolvedValue(ok(portfolio({ tokens: [token("WBTC", 40)] })));
    renderWith(<BalancesCard scope={{ kind: "wallet", wallet: EVM_WALLET }} />);

    await screen.findByText("WBTC");
    expect(readMock).toHaveBeenCalledWith({
      scope: "global",
      walletAddress: EVM_WALLET.address,
    });
  });

  it("shows at most the top five holdings, largest USD first, dust cut before the cap", async () => {
    // Seven priced rows: one sub-cent dust row ($0.004 < $0.005 threshold)
    // must be dropped BEFORE the top-5 cut, so the $1 row still makes the
    // list; the sixth-largest real row ($2) then falls off the cap.
    readMock.mockResolvedValue(
      ok(
        portfolio({
          tokens: [
            token("DUST", 0.004),
            token("A", 500),
            token("B", 400),
            token("C", 300),
            token("D", 200),
            token("E", 100),
            token("F", 2),
          ],
        }),
      ),
    );
    renderWith(<BalancesCard scope={{ kind: "global" }} />);

    await screen.findByText("A");
    expect(balanceNames()).toEqual(["A", "B", "C", "D", "E"]);
    expect(screen.queryByText("F")).toBeNull();
    expect(screen.queryByText("DUST")).toBeNull();
  });

  it("every scope speaks its own empty sentence", async () => {
    const cases: readonly {
      readonly scope: Parameters<typeof BalancesCard>[0]["scope"];
      readonly note: string;
    }[] = [
      {
        scope: { kind: "global" },
        note: "No balances yet - fund a wallet and your holdings appear here.",
      },
      { scope: { kind: "wallet", wallet: EVM_WALLET }, note: "No balances in this wallet yet." },
      {
        scope: { kind: "session", sessionId: SESSION },
        note: "No balances in this session's wallets yet - fund them and your holdings appear here.",
      },
      {
        scope: { kind: "project", projectId: PROJECT },
        note: "No balances in this project's wallets yet - fund them and your holdings appear here.",
      },
    ];
    readMock.mockResolvedValue(ok(portfolio({ tokens: [] })));
    for (const { scope, note } of cases) {
      renderWith(<BalancesCard scope={scope} />);
      await screen.findByText(note);
      cleanup();
    }
  });
});

describe("WalletsCard", () => {
  it("renders one identity row per inventory wallet, each family's first marked Primary", async () => {
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], [SOL_WALLET]));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    await screen.findByText("Main");
    // Both family firsts wear the muted word (the labeled EVM row and the
    // unlabeled Solana row, which falls back to the terse family caption).
    expect(screen.getAllByText(/Primary/)).toHaveLength(2);
    expect(cellsOf(rowContaining("Main"))[0]).toBe("Main · Primary");
    expect(cellsOf(rowContaining("SOL"))[0]).toBe("SOL · Primary");
    expect(
      [...document.querySelectorAll("thead th")].map((th) => th.textContent),
    ).toEqual(["Wallet", "Address", "Value", "Actions"]);
  });

  it("tells a family's later unlabeled wallet by its short address, and drops a redundant Primary", async () => {
    const primaryLabeled: AvailableWalletDto = { ...EVM_WALLET, label: "Primary" };
    listAvailableMock.mockResolvedValue(inventory([primaryLabeled, EVM_WALLET_2], []));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    await screen.findByText("Primary");
    // The label already says Primary: no second "Primary" beside it.
    expect(cellsOf(rowContaining("Primary"))[0]).toBe("Primary");
    // The second unlabeled EVM wallet reads as the family plus its address.
    expect(cellsOf(rowContaining("0x2222"))[0]).toBe("EVM · 0x2222…2222");
  });

  it("shows the short address with the full one in its tooltip", async () => {
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], []));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    const code = await screen.findByText("0x1111…1111");
    expect(code.tagName).toBe("CODE");
    expect(code.getAttribute("title")).toBe(EVM_WALLET.address);
  });

  it("reads each wallet's own figure by its address, and prints the inventory's own Total", async () => {
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], [SOL_WALLET]));
    readMock.mockImplementation((input) => {
      if (input.scope !== "global") return Promise.resolve(ok(portfolio()));
      if (input.walletAddress === EVM_WALLET.address) {
        return Promise.resolve(ok(portfolio({ liveTotalUsd: 100 })));
      }
      if (input.walletAddress === SOL_WALLET.address) {
        return Promise.resolve(ok(portfolio({ liveTotalUsd: 200 })));
      }
      return Promise.resolve(ok(portfolio({ liveTotalUsd: 1234.56 })));
    });
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    await screen.findByText("$100.00");
    expect(cellsOf(rowContaining("Main"))[2]).toBe("$100.00");
    await waitFor(() => expect(cellsOf(rowContaining("SOL"))[2]).toBe("$200.00"));
    // The Total row is the global read's own total, not a sum the renderer makes.
    const total = rowContaining("Total");
    expect(cellsOf(total)[2]).toBe("$1,234.56");
    expect(total.textContent).not.toContain("$300.00");
    expect(total.classList.contains("vex-pf-total")).toBe(true);
    expect(readMock).toHaveBeenCalledWith({ scope: "global" });
    expect(readMock).toHaveBeenCalledWith({
      scope: "global",
      walletAddress: EVM_WALLET.address,
    });
  });

  it("says Not available for a wallet or total whose read failed, never a zero", async () => {
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], []));
    readMock.mockResolvedValue(
      err(READ_FAILED),
    );
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    await screen.findByText("Main");
    await waitFor(() => expect(cellsOf(rowContaining("Total"))[2]).toBe("Not available"));
    expect(cellsOf(rowContaining("Main"))[2]).toBe("Not available");
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("marks the selected wallet's row under a wallet scope, and none under global", async () => {
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], [SOL_WALLET]));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "wallet", wallet: SOL_WALLET }} />);

    await screen.findByText("Main");
    expect(rowContaining("SOL").getAttribute("data-selected")).toBe("true");
    expect(rowContaining("SOL").getAttribute("aria-current")).toBe("true");
    expect(rowContaining("Main").hasAttribute("data-selected")).toBe(false);
    cleanup();

    renderWith(<WalletsCard scope={{ kind: "global" }} />);
    await screen.findByText("Main");
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  it("Add wallet routes to the Settings wallets section through the public store action", async () => {
    listAvailableMock.mockResolvedValue(inventory([], []));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    // Nothing configured: the invitation names the way, and the head key stays.
    await screen.findByText("No wallets configured yet. Add your first with Add wallet.");
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));

    await waitFor(() => {
      expect(useUiStore.getState().shellRoute).toEqual({
        kind: "settings",
        origin: ORIGIN_ZERO,
        section: "wallets",
      });
    });
  });

  it("keeps Add wallet in the head beside a populated table", async () => {
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], []));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    await screen.findByText("Main");
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    expect(useUiStore.getState().shellRoute.kind).toBe("settings");
  });

  it("copies a wallet's full address from its row menu and confirms it", async () => {
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], [SOL_WALLET]));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    await screen.findByText("Main");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Main" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Copy address",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy address" }));

    expect(writeTextMock).toHaveBeenCalledWith(EVM_WALLET.address);
    await screen.findByText("Address copied");
    expect(rowContaining("Main").textContent).toContain("Address copied");
    expect(rowContaining("SOL").textContent).not.toContain("Address copied");
  });

  it("never claims a copy the host refused", async () => {
    writeTextMock.mockRejectedValue(new Error("denied"));
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], []));
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    await screen.findByText("Main");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Main" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy address" }));

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(EVM_WALLET.address));
    // Let the refused write (and the selection fallback) settle before the
    // negative is asserted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(screen.queryByText("Address copied")).toBeNull();
  });

  it("says Loading, then reports a failed inventory read as its own error line", async () => {
    listAvailableMock.mockResolvedValue(
      err(READ_FAILED),
    );
    readMock.mockResolvedValue(ok(portfolio()));
    renderWith(<WalletsCard scope={{ kind: "global" }} />);

    expect(screen.getByText("Loading…")).not.toBeNull();
    await screen.findByText("Couldn't load your wallets.");
    expect(screen.queryByText(/No wallets configured yet/)).toBeNull();
    expect(bodyRows()).toHaveLength(0);
  });
});

describe("a session or project card never reads the global wallet inventory", () => {
  it("a project's wallet pair reads the project, narrows each row by its own address, and leaves the inventory alone", async () => {
    projectsGetMock.mockResolvedValue(
      ok({
        id: PROJECT,
        name: "Acme",
        wallets: {
          evm: { id: "evm_1", address: EVM_WALLET.address },
          solana: null,
        },
      }),
    );
    readMock.mockResolvedValue(ok(portfolio({ liveTotalUsd: 321.09, walletCount: 1 })));
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], [SOL_WALLET]));
    const { client } = renderWithClient(
      <WalletPairCard scope={{ kind: "project", projectId: PROJECT }} />,
    );

    await screen.findByText("$321.09");
    expect(projectsGetMock).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(listSessionWalletsMock).not.toHaveBeenCalled();
    expect(listAvailableMock).not.toHaveBeenCalled();
    expect(client.getQueryData(["wallets", "available"])).toBeUndefined();
    // The only read is the project wallet's own, narrowed by its address.
    expect(readInputs()).toEqual([
      { scope: "global", walletAddress: EVM_WALLET.address },
    ]);
  });

  it("a session's wallet pair reads the session, never the project and never the inventory", async () => {
    listSessionWalletsMock.mockResolvedValue(
      ok({
        sessionId: SESSION,
        evm: null,
        solana: { walletId: "w-sol", address: SOL_WALLET.address, label: "Spend" },
      }),
    );
    readMock.mockResolvedValue(ok(portfolio({ liveTotalUsd: 55.5, walletCount: 1 })));
    listAvailableMock.mockResolvedValue(inventory([EVM_WALLET], [SOL_WALLET]));
    const { client } = renderWithClient(
      <WalletPairCard scope={{ kind: "session", sessionId: SESSION }} />,
    );

    await screen.findByText("$55.50");
    expect(cellsOf(rowContaining("Spend"))[0]).toBe("Spend");
    expect(listSessionWalletsMock).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(projectsGetMock).not.toHaveBeenCalled();
    expect(listAvailableMock).not.toHaveBeenCalled();
    expect(client.getQueryData(["wallets", "available"])).toBeUndefined();
    expect(readInputs()).toEqual([
      { scope: "global", walletAddress: SOL_WALLET.address },
    ]);
  });
});

describe("the page scope model", () => {
  const TWO_EVM_ONE_SOL = flattenPortfolioWallets({
    evm: [EVM_WALLET, EVM_WALLET_2],
    solana: [SOL_WALLET],
  });

  it("offers All wallets first, then one chip per wallet, then the shell's context chips", () => {
    const options = portfolioScopeOptions(TWO_EVM_ONE_SOL, {
      sessionId: SESSION,
      projectId: PROJECT,
    });

    expect(options.map((option) => option.key)).toEqual([
      ALL_WALLETS_KEY,
      "wallet:evm-1",
      "wallet:evm-2",
      "wallet:sol-1",
      THIS_CHAT_KEY,
      THIS_PROJECT_KEY,
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "All wallets",
      "Main",
      "EVM",
      "SOL",
      "This chat",
      "This project",
    ]);
    // A wallet chip carries its muted word and its full address as a tooltip.
    expect(options[1]?.detail).toBe("Primary");
    expect(options[1]?.title).toBe(EVM_WALLET.address);
    expect(options[2]?.detail).toBe("0x2222…2222");
    expect(options[3]?.detail).toBe("Primary");
    // Each chip's scope is the read it stands for.
    expect(options[0]?.scope).toEqual({ kind: "global" });
    expect(options[1]?.scope).toEqual({ kind: "wallet", wallet: EVM_WALLET });
    expect(options[4]?.scope).toEqual({ kind: "session", sessionId: SESSION });
    expect(options[5]?.scope).toEqual({ kind: "project", projectId: PROJECT });
  });

  it("hides the wallet chips at exactly one wallet and shows them at two", () => {
    const one = portfolioScopeOptions(
      flattenPortfolioWallets({ evm: [EVM_WALLET], solana: [] }),
      { sessionId: null, projectId: null },
    );
    expect(one.map((option) => option.key)).toEqual([ALL_WALLETS_KEY]);

    const two = portfolioScopeOptions(
      flattenPortfolioWallets({ evm: [EVM_WALLET], solana: [SOL_WALLET] }),
      { sessionId: null, projectId: null },
    );
    expect(two.map((option) => option.key)).toEqual([
      ALL_WALLETS_KEY,
      "wallet:evm-1",
      "wallet:sol-1",
    ]);
  });

  it("offers a context chip only for the context the shell holds", () => {
    const wallets = flattenPortfolioWallets({ evm: [EVM_WALLET], solana: [] });
    expect(
      portfolioScopeOptions(wallets, { sessionId: SESSION, projectId: null }).map(
        (option) => option.key,
      ),
    ).toEqual([ALL_WALLETS_KEY, THIS_CHAT_KEY]);
    expect(
      portfolioScopeOptions(wallets, { sessionId: null, projectId: PROJECT }).map(
        (option) => option.key,
      ),
    ).toEqual([ALL_WALLETS_KEY, THIS_PROJECT_KEY]);
  });

  it("falls back to All wallets when the held key vanished", () => {
    const options = portfolioScopeOptions(TWO_EVM_ONE_SOL, {
      sessionId: null,
      projectId: null,
    });
    expect(selectScopeOption(options, "wallet:evm-2").key).toBe("wallet:evm-2");
    expect(selectScopeOption(options, THIS_CHAT_KEY).key).toBe(ALL_WALLETS_KEY);
    expect(selectScopeOption(options, "wallet:removed").scope).toEqual({ kind: "global" });
    expect(selectScopeOption([], "anything").scope).toEqual({ kind: "global" });
  });

  it("maps a single wallet to the global card scope, and session and project to their own", () => {
    expect(cardScopeOf({ kind: "global" })).toEqual({ kind: "global" });
    expect(cardScopeOf({ kind: "wallet", wallet: EVM_WALLET })).toEqual({ kind: "global" });
    expect(cardScopeOf({ kind: "session", sessionId: SESSION })).toEqual({
      kind: "session",
      sessionId: SESSION,
    });
    expect(cardScopeOf({ kind: "project", projectId: PROJECT })).toEqual({
      kind: "project",
      projectId: PROJECT,
    });
  });
});
